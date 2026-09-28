"""Fetch a small public daily-price snapshot; never fabricate missing prices.
No brokerage, order, login or account data is used. Run manually to refresh.
The upstream chart endpoint is not a contracted real-time market-data feed.
"""
import datetime as dt
import hashlib
import json
import pathlib
import time
import urllib.request
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parent
now = dt.datetime.now(ZoneInfo('Asia/Seoul'))
cutoff = now.date() - dt.timedelta(days=1)
symbols = [('005930', '삼성전자'), ('000660', 'SK하이닉스'), ('035420', 'NAVER')]
out = {'schema': 1, 'fetched_at': now.isoformat(), 'cutoff': cutoff.isoformat(),
       'provider': '네이버 증권 차트 일봉', 'realtime': False,
       'adjustment': '공급자 차트 가격. 수정주가 및 권리변동의 독립 검증은 하지 않음. 배당 제외.',
       'stocks': [], 'errors': []}
raw_dir = ROOT / 'source-audit'
raw_dir.mkdir(exist_ok=True)
for code, name in symbols:
    url = ('https://fchart.stock.naver.com/sise.nhn?symbol=' + code +
           '&timeframe=day&count=1700&requestType=0')
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read(3000000)
        (raw_dir / (code + '.xml')).write_bytes(raw)
        root = ET.fromstring(raw)
        rows = []
        seen = set()
        for item in root.findall('.//item'):
            values = item.attrib.get('data', '').split('|')
            if len(values) < 6:
                raise ValueError('Unexpected price row structure')
            date = dt.datetime.strptime(values[0], '%Y%m%d').date()
            if date > cutoff or date < dt.date(2021, 1, 1):
                continue
            o, h, l, c, v = [int(x) for x in values[1:6]]
            if date in seen:
                raise ValueError('Duplicate date ' + str(date))
            seen.add(date)
            if v == 0 and (o == 0 or h == 0 or l == 0):
                raise ValueError('Suspended/missing OHLC row: ' + str(date))
            if min(o, h, l, c) <= 0 or l > min(o, c) or h < max(o, c) or h < l or v < 0:
                raise ValueError('Invalid OHLC row: ' + str(date))
            rows.append([date.isoformat(), o, h, l, c, v])
        rows.sort()
        if len(rows) < 250:
            raise ValueError('Too few rows: ' + str(len(rows)))
        out['stocks'].append({'code': code, 'name': name, 'source_url': url,
            'sha256': hashlib.sha256(raw).hexdigest(), 'rows': rows,
            'first_date': rows[0][0], 'last_date': rows[-1][0], 'row_count': len(rows)})
        print(code, name, len(rows), rows[0][0], rows[-1][0])
    except Exception as exc:
        out['errors'].append({'code': code, 'name': name, 'error': str(exc)})
        print(code, 'FAILED:', exc)
    time.sleep(1)
if not out['stocks']:
    raise SystemExit('No verified price rows retrieved; existing data was NOT replaced.')
(ROOT / 'prices.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
(ROOT / 'data-status.json').write_text(json.dumps({k: v for k, v in out.items() if k != 'stocks'} | {
    'stocks': [{k: v for k, v in s.items() if k != 'rows'} for s in out['stocks']]},
    ensure_ascii=False, indent=2), encoding='utf-8')
