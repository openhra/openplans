#!/usr/bin/env python3
"""Public health check for the OpenPlans service: readiness, status and the MCP endpoint.

One pass makes at most 6 anonymous requests over TLS to the public hostname (no proxy, no
credentials): GET /readyz, GET /status.json, then MCP initialize, notifications/initialized,
tools/list and a tools/call of get_data_status. The MCP server name and version must match
status.json, and the tool names must equal the anonymous list in docs/public-contract.json.
Standard library only, so it runs anywhere Python 3.9 or newer does.

Run `python3 scripts/public_health.py` (exit 0 healthy, 1 unhealthy, 2 the check cannot run).
A failed pass is tried again after --retry-wait seconds, up to --attempts passes.
"""
import argparse
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
PUBLIC = 'https://openplans.openhra.com'
CONTRACT = ROOT / 'docs/public-contract.json'
MCP_PROTOCOL = '2025-11-25'
TIMEOUT_SECONDS = 10
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_REQUESTS = 6
USER_AGENT = 'openplans-health-probe/1'
CHECKS = ('readyz', 'status', 'mcp_initialize', 'mcp_initialized', 'mcp_tools_list', 'mcp_get_data_status')


class SetupError(Exception):
    pass


def mcp_document(text):
    """The JSON-RPC message from a JSON or an event-stream answer."""
    try:
        return json.loads(text)
    except ValueError:
        pass
    for line in reversed(text.splitlines()):
        if line.startswith('data:'):
            try:
                return json.loads(line[5:].strip())
            except ValueError:
                return None
    return None


def contract_tools(path=CONTRACT):
    try:
        names = json.loads(Path(path).read_text())['mcp']['anonymous_tools']
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SetupError('contract unreadable: ' + type(error).__name__)
    if not isinstance(names, list) or not names or not all(isinstance(n, str) for n in names):
        raise SetupError('contract has no anonymous tool list')
    return sorted(names)


def check_base(base):
    parts = urllib.parse.urlsplit(base)
    loopback = parts.hostname in ('127.0.0.1', 'localhost', '::1')
    if parts.scheme not in ('https', 'http') or not parts.hostname or parts.path not in ('', '/') \
            or parts.username or parts.query or parts.fragment or (parts.scheme == 'http' and not loopback):
        raise SetupError('base must be https://host (plain http only on loopback)')
    return base.rstrip('/')


class Client:
    def __init__(self, base, timeout):
        self.base, self.timeout, self.sent = base, timeout, 0
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.session = None

    def request(self, method, path, body=None, headers=None):
        """(status, headers, text, ms); status 0 with the exception class name as text on a transport failure."""
        if self.sent >= MAX_REQUESTS:
            raise SetupError('request budget spent')
        self.sent += 1
        head = {'User-Agent': USER_AGENT, 'Accept': 'application/json', **(headers or {})}
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            head['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=head)
        start = time.monotonic()
        try:
            try:
                response = self.opener.open(request, timeout=self.timeout)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                text = response.read(MAX_BODY_BYTES + 1)[:MAX_BODY_BYTES].decode('utf-8', 'replace')
                result = (response.status, {k.lower(): v for k, v in response.headers.items()}, text)
        except (urllib.error.URLError, OSError, ValueError) as error:
            name = type(getattr(error, 'reason', error)).__name__
            result = (0, {}, name)
        return (*result, int((time.monotonic() - start) * 1000))

    def mcp(self, method, params=None, notification=False, tool=None):
        headers = {'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': MCP_PROTOCOL,
                   'Mcp-Method': method}
        if tool:
            headers['Mcp-Name'] = tool
        if self.session:
            headers['Mcp-Session-Id'] = self.session
        message = {'jsonrpc': '2.0', 'method': method, 'params': params or {}}
        if not notification:
            message['id'] = 1
        result = self.request('POST', '/mcp', message, headers)
        if result[1].get('mcp-session-id'):
            self.session = result[1]['mcp-session-id']
        return result


def outcome(ok, ms, error=None):
    return {'ok': bool(ok), 'ms': ms, 'error': None if ok else error}


def transport(status, text):
    return 'transport ' + text if status == 0 else 'http ' + str(status)


def rpc(status, headers, text):
    """(result, error text) of a JSON-RPC answer."""
    if status != 200:
        return None, transport(status, text)
    document = mcp_document(text)
    if not isinstance(document, dict) or document.get('jsonrpc') != '2.0':
        return None, 'not a JSON-RPC answer'
    if 'error' in document or not isinstance(document.get('result'), dict):
        return None, 'JSON-RPC error'
    return document['result'], None


def probe(base, tools, timeout=TIMEOUT_SECONDS):
    """One pass: a dict of check name -> {ok, ms, error}. At most 6 requests."""
    client = Client(base, timeout)
    results = {}
    status, _, text, ms = client.request('GET', '/readyz')
    results['readyz'] = outcome(status == 200, ms, transport(status, text))
    status, _, text, ms = client.request('GET', '/status.json')
    version, error = None, None
    if status == 200:
        try:
            version = json.loads(text).get('version')
        except (ValueError, AttributeError):
            version = None
        if not isinstance(version, str) or not version:
            version, error = None, 'status.json has no version'
    else:
        error = transport(status, text)
    results['status'] = outcome(version, ms, error)

    status, headers, text, ms = client.mcp('initialize', {
        'protocolVersion': MCP_PROTOCOL, 'capabilities': {},
        'clientInfo': {'name': 'health-probe', 'version': '1'}})
    result, error = rpc(status, headers, text)
    if result is not None:
        info = result.get('serverInfo') if isinstance(result.get('serverInfo'), dict) else {}
        if result.get('protocolVersion') != MCP_PROTOCOL:
            error = 'protocolVersion not echoed'
        elif info.get('name') != 'openplans':
            error = 'serverInfo name differs'
        elif version is None or info.get('version') != version:
            error = 'serverInfo version differs from status.json'
    results['mcp_initialize'] = outcome(result is not None and error is None, ms, error)

    status, _, text, ms = client.mcp('notifications/initialized', notification=True)
    results['mcp_initialized'] = outcome(200 <= status < 300, ms, transport(status, text))

    status, headers, text, ms = client.mcp('tools/list')
    result, error = rpc(status, headers, text)
    if result is not None:
        listed = result.get('tools')
        names = sorted(t.get('name') for t in listed if isinstance(t, dict)) if isinstance(listed, list) else []
        if not names:
            error = 'tools/list is empty'
        elif names != tools:
            missing = sorted(set(tools) - set(names))
            extra = sorted(set(names) - set(tools))
            error = 'tool list differs from contract: missing ' + ','.join(missing) + ' extra ' + ','.join(extra)
    results['mcp_tools_list'] = outcome(result is not None and error is None, ms, error)

    status, headers, text, ms = client.mcp('tools/call', {'name': 'get_data_status', 'arguments': {}},
                                           tool='get_data_status')
    result, error = rpc(status, headers, text)
    if result is not None and result.get('isError'):
        error = 'tool reported isError'
    results['mcp_get_data_status'] = outcome(result is not None and error is None, ms, error)
    return results, version, client.sent


def failures(results):
    return '; '.join(name + ': ' + (r['error'] or 'failed') for name, r in results.items() if not r['ok'])


def main(argv=None, sleep=time.sleep):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--base', default=PUBLIC)
    parser.add_argument('--contract', type=Path, default=CONTRACT)
    parser.add_argument('--timeout', type=float, default=TIMEOUT_SECONDS)
    parser.add_argument('--attempts', type=int, default=2)
    parser.add_argument('--retry-wait', type=float, default=60)
    parser.add_argument('--json', action='store_true', help='print the last pass as JSON')
    args = parser.parse_args(argv)
    try:
        base, tools = check_base(args.base), contract_tools(args.contract)
        if not 0 < args.timeout <= 30 or not 1 <= args.attempts <= 3 or not 0 <= args.retry_wait <= 120:
            raise SetupError('timeout, attempts or retry wait out of range')
    except SetupError as error:
        print('FAIL: health check cannot run: ' + str(error), file=sys.stderr)
        return 2
    for attempt in range(1, args.attempts + 1):
        results, version, _ = probe(base, tools, args.timeout)
        healthy = all(r['ok'] for r in results.values())
        if args.json:
            print(json.dumps({'healthy': healthy, 'version': version, 'checks': results}, sort_keys=True, indent=1))
        else:
            timings = ' '.join(name + '=' + str(r['ms']) + 'ms' for name, r in results.items())
            print(('PASS' if healthy else 'FAIL') + ' (attempt ' + str(attempt) + '): ' + timings
                  + ('' if healthy else ' | ' + failures(results)), flush=True)
        if healthy:
            return 0
        if attempt < args.attempts:
            sleep(args.retry_wait)
    return 1


if __name__ == '__main__':
    sys.exit(main())
