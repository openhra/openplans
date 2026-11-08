#!/usr/bin/env python3
"""Independent cache-only projection of public Cigna TX PY2026 provider JSON."""
import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import re


def records(stream, digest):
    """Bounded root-array reader; stdlib decoder, independent of the TS adapter."""
    decoder = json.JSONDecoder()
    text, pos, eof, first = '', 0, False, True
    # TextIOWrapper incrementally decodes UTF-8; hash exactly the underlying bytes.
    class Hashed(io.RawIOBase):
        def readable(self): return True
        def readinto(self, b):
            chunk = stream.read(len(b))
            digest.update(chunk)
            b[:len(chunk)] = chunk
            return len(chunk)
    reader = io.TextIOWrapper(io.BufferedReader(Hashed()), encoding='utf-8-sig')
    def more():
        nonlocal text, pos, eof
        chunk = reader.read(1024 * 1024)
        text, pos, eof = text[pos:] + chunk, 0, not chunk
        if len(text) > 16 * 1024 * 1024: raise ValueError('Provider record exceeds oracle bound')
    def whitespace():
        nonlocal pos
        while True:
            while pos < len(text) and text[pos].isspace(): pos += 1
            if pos < len(text) or eof: return
            more()
    more(); whitespace()
    if text[pos:pos+1] != '[': raise ValueError('Expected root array')
    pos += 1
    while True:
        whitespace()
        if text[pos:pos+1] == ']':
            pos += 1
            break
        if not first:
            if text[pos:pos+1] != ',': raise ValueError('Missing array comma')
            pos += 1; whitespace()
        while True:
            try: value, end = decoder.raw_decode(text, pos); break
            except json.JSONDecodeError:
                if eof: raise
                more()
        pos, first = end, False
        yield value
    whitespace()
    if text[pos:].strip(): raise ValueError('Trailing provider JSON')


def raw_pairs(stream):
    digest, pairs, count, edges, dates = hashlib.sha256(), Counter(), 0, 0, set()
    for row in records(stream, digest):
        count += 1
        dates.add(row.get('last_updated_on'))
        npi = row.get('npi')
        for edge in row['plans']:
            if not re.fullmatch(r'76589TX\d{7}', edge.get('plan_id', '')) or 2026 not in edge.get('years', []): continue
            edges += 1
            if npi: pairs[(npi, edge['plan_id'])] += 1
    return pairs, {'sha256': digest.hexdigest(), 'records': count, 'record_edges': edges, 'source_dates': sorted(d for d in dates if d)}


def read_pairs(path):
    pairs = Counter()
    with Path(path).open() as stream:
        for line in stream:
            npi, plan, count = json.loads(line)
            if (npi, plan) in pairs: raise ValueError('Duplicate exported pair')
            pairs[(npi, plan)] = count
    return pairs


def compare_raw(actual, published):
    errors = sorted(key for key in set(actual) | set(published) if actual[key] != published[key])
    return {'passed': not errors, 'pairs': len(actual), 'record_edges': sum(actual.values()),
            'mismatches': [{'npi': k[0], 'plan': k[1], 'stored': actual[k], 'raw': published[k]} for k in errors]}


def main(args):
    actual = read_pairs(args.actual)
    with Path(args.current).open('rb') as stream:
        published, source = raw_pairs(stream)
    result = compare_raw(actual, published)
    mutant = actual.copy()
    if not mutant:
        raise ValueError('No persisted provider pairs for negative control')
    key = next(iter(mutant))
    mutant[key] -= 1
    broken = compare_raw(mutant, published)
    control = {'name': 'removed_provider_record_edge', 'passed': result['passed'] and not broken['passed']}
    result.update(source=source, negative_controls=[control])
    result['passed'] = result['passed'] and control['passed']
    Path(args.output).write_text(json.dumps(result) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['actual', 'current', 'output']:
        parser.add_argument('--' + name, required=True)
    main(parser.parse_args())
