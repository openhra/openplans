"""Bounded, read-only BIFF8/CFB reader for DFS's public approved rate templates.

Reads cached cells only. Never evaluates formulas, executes macros, or opens an
Office application. Deliberately rejects encrypted workbooks and unsupported cells.
"""
import math
import struct

END = 0xFFFFFFFA


def cfb_stream(data, names):
    """Return the first named CFB stream present, or None when none of `names` exists."""
    if len(data) > 50 * 1024 * 1024 or data[:8] != bytes.fromhex('d0cf11e0a1b11ae1'):
        raise ValueError('Invalid or oversized CFB workbook')
    sector_size = 1 << struct.unpack_from('<H', data, 30)[0]
    if sector_size not in (512, 4096):
        raise ValueError('Unsupported CFB sector size')
    def sector(n):
        start = (n + 1) * sector_size
        if start + sector_size > len(data):
            raise ValueError('CFB sector out of bounds')
        return data[start:start + sector_size]
    fat_sectors = [n for n in struct.unpack_from('<109I', data, 76) if n < END]
    next_difat, difat_count = struct.unpack_from('<II', data, 68)
    seen = set()
    for _ in range(difat_count):
        if next_difat in seen:
            raise ValueError('CFB DIFAT cycle')
        seen.add(next_difat)
        entries = struct.unpack('<' + str(sector_size // 4) + 'I', sector(next_difat))
        fat_sectors.extend(n for n in entries[:-1] if n < END)
        next_difat = entries[-1]
    if len(fat_sectors) != struct.unpack_from('<I', data, 44)[0]:
        raise ValueError('CFB FAT count mismatch')
    fat = [n for s in fat_sectors for n in struct.unpack('<' + str(sector_size // 4) + 'I', sector(s))]
    def chain(start, table=fat, size=sector_size, payload=None):
        result, visited = bytearray(), set()
        while start < END:
            if start in visited or start >= len(table):
                raise ValueError('CFB chain cycle or missing sector')
            visited.add(start)
            result.extend(sector(start) if payload is None else payload[start * size:(start + 1) * size])
            if len(result) > 50 * 1024 * 1024:
                raise ValueError('CFB stream limit')
            start = table[start]
        return bytes(result)
    directory = chain(struct.unpack_from('<I', data, 48)[0])
    entries = {}
    root = None
    for offset in range(0, len(directory), 128):
        entry = directory[offset:offset + 128]
        length = struct.unpack_from('<H', entry, 64)[0]
        if not length:
            continue
        if not 2 <= length <= 64:
            raise ValueError('CFB directory name limit')
        name = entry[:length - 2].decode('utf-16le')
        start, size = struct.unpack_from('<IQ', entry, 116)
        if entry[66] == 5:
            root = (start, size)
        entries[name] = (start, size)
    start, size = next((entries[n] for n in names if n in entries), (None, 0))
    if start is None:
        return None
    if size >= struct.unpack_from('<I', data, 56)[0]:
        return chain(start)[:size]
    if root is None:
        raise ValueError('Missing CFB mini stream')
    mini_data = chain(root[0])[:root[1]]
    mini_fat_data = chain(struct.unpack_from('<I', data, 60)[0])
    mini_fat = struct.unpack('<' + str(len(mini_fat_data) // 4) + 'I', mini_fat_data)
    return chain(start, mini_fat, 64, mini_data)[:size]


def workbook_stream(data):
    stream = cfb_stream(data, ('Workbook', 'Book'))
    if stream is None:
        raise ValueError('No BIFF workbook stream')
    return stream


class Strings:
    def __init__(self, segments):
        self.parts, self.part, self.at = segments, 0, 0

    def next(self):
        self.part += 1
        self.at = 0
        if self.part >= len(self.parts):
            raise ValueError('Truncated BIFF string')

    def read(self, n):
        result = bytearray()
        while n:
            if self.at == len(self.parts[self.part]):
                self.next()
            count = min(n, len(self.parts[self.part]) - self.at)
            result += self.parts[self.part][self.at:self.at + count]
            self.at += count
            n -= count
        return bytes(result)

    def string(self):
        count = struct.unpack('<H', self.read(2))[0]
        flags = self.read(1)[0]
        runs = struct.unpack('<H', self.read(2))[0] if flags & 8 else 0
        extension = struct.unpack('<I', self.read(4))[0] if flags & 4 else 0
        wide = bool(flags & 1)
        result = []
        while count:
            if self.at == len(self.parts[self.part]):
                self.next()
                wide = bool(self.read(1)[0] & 1)
            size = 2 if wide else 1
            available = (len(self.parts[self.part]) - self.at) // size
            if not available:
                raise ValueError('Split BIFF Unicode character')
            n = min(count, available)
            result.append(self.read(n * size).decode('utf-16le' if wide else 'latin1'))
            count -= n
        self.read(runs * 4 + extension)
        return ''.join(result)


def rk_value(data):
    value = struct.unpack('<I', data)[0]
    number = struct.unpack('<i', data)[0] >> 2 if value & 2 else struct.unpack('<d', b'\0' * 4 + struct.pack('<I', value & 0xFFFFFFFC))[0]
    return number / 100 if value & 1 else number


def biff_sheets(data):
    data = workbook_stream(data)
    records, at = [], 0
    while at + 4 <= len(data):
        kind, size = struct.unpack_from('<HH', data, at)
        if at + 4 + size > len(data):
            raise ValueError('Truncated BIFF record')
        records.append((at, kind, data[at + 4:at + 4 + size]))
        at += 4 + size
    if any(kind == 0x2F for _, kind, _ in records):
        raise ValueError('Encrypted workbook is not supported')
    shared = []
    for i, (_, kind, payload) in enumerate(records):
        if kind != 0xFC:
            continue
        total, unique = struct.unpack_from('<II', payload)
        if unique > 100000:
            raise ValueError('BIFF shared string limit')
        segments = [payload[8:]]
        for _, next_kind, p in records[i + 1:]:
            if next_kind != 0x3C:
                break
            segments.append(p)
        reader = Strings(segments)
        shared = [reader.string() for _ in range(unique)]
    sheets = []
    for _, kind, p in records:
        if kind == 0x85:
            offset = struct.unpack_from('<I', p)[0]
            count, wide = p[6], p[7] & 1
            sheets.append((offset, p[8:8 + count * (2 if wide else 1)].decode('utf-16le' if wide else 'latin1')))
    result = {}
    for start, name in sheets:
        end = min([offset for offset, _ in sheets if offset > start] or [len(data)])
        cells = {}
        pending = None
        def add(row, col, value):
            if isinstance(value, (int, float)):
                if not math.isfinite(value):
                    raise ValueError('Invalid cached BIFF number')
                value = str(value)
            cells.setdefault(row + 1, {})[col] = value
        for offset, kind, p in records:
            if not start <= offset < end:
                continue
            if kind == 0xFD:
                row, col, fmt, index = struct.unpack('<HHHI', p)
                add(row, col, shared[index])
            elif kind in (0x203, 0x27E, 0x06):
                row, col, fmt = struct.unpack_from('<HHH', p)
                if kind == 0x06 and p[12:14] == b'\xff\xff':
                    if p[6] == 0:
                        pending = row, col
                    continue
                add(row, col, rk_value(p[6:10]) if kind == 0x27E else struct.unpack_from('<d', p, 6)[0])
            elif kind == 0xBD:
                row, col = struct.unpack_from('<HH', p)
                for i in range(4, len(p) - 2, 6):
                    add(row, col + (i - 4) // 6, rk_value(p[i + 2:i + 6]))
            elif kind == 0x207 and pending:
                add(*pending, Strings([p]).string())
                pending = None
        result[name] = cells
    return result
