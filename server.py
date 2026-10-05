"""Lokaler Server für GridBot Master.

Liefert die App-Dateien aus (wie `python -m http.server`) und speichert zusätzlich die
Bot-Listen des Bot-Monitorings in data/bots.json im App-Verzeichnis:

    GET /api/bots  -> Inhalt von data/bots.json (404, solange noch nichts gespeichert wurde)
    PUT /api/bots  -> JSON {"bots": [...], "removed": [...], "settings": {...}} speichern (settings optional)

Der Server lauscht nur auf 127.0.0.1, ist also von anderen Geräten aus nicht erreichbar.
"""

import json
import os
import sys
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, 'data')
BOTS_FILE = os.path.join(DATA_DIR, 'bots.json')
MAX_BODY = 5 * 1024 * 1024  # 5 MB


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split('?')[0] != '/api/bots':
            return super().do_GET()
        if not os.path.exists(BOTS_FILE):
            return self._send_json(404, {'error': 'noch keine Daten gespeichert'})
        try:
            with open(BOTS_FILE, encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError) as e:
            return self._send_json(500, {'error': f'bots.json nicht lesbar: {e}'})
        self._send_json(200, data)

    def do_PUT(self):
        if self.path.split('?')[0] != '/api/bots':
            return self._send_json(404, {'error': 'unbekannter Pfad'})
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send_json(400, {'error': 'ungültige Grösse'})
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except ValueError:
            return self._send_json(400, {'error': 'kein gültiges JSON'})
        if not isinstance(data, dict) or not isinstance(data.get('bots'), list) or not isinstance(data.get('removed'), list):
            return self._send_json(400, {'error': 'erwartet {"bots": [...], "removed": [...]}'})

        payload = {
            'savedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'bots': data['bots'],
            'removed': data['removed'],
        }
        # Optionale Einstellungen der Seite (z. B. Startkapital der Equity-Karte)
        if isinstance(data.get('settings'), dict):
            payload['settings'] = data['settings']
        os.makedirs(DATA_DIR, exist_ok=True)
        # Erst in eine temporäre Datei schreiben und dann ersetzen, damit bots.json nie halb geschrieben ist
        tmp = BOTS_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, BOTS_FILE)
        self._send_json(200, {'ok': True, 'savedAt': payload['savedAt']})

    def end_headers(self):
        # App-Dateien nicht cachen, damit Änderungen sofort ankommen
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'GridBot Master laeuft auf http://localhost:{port}')
    print(f'Bot-Listen werden gespeichert in {BOTS_FILE}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
