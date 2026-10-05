# GridBot Master

Zusammengeführte Web-App: Eignungsprüfung & Parameter-Optimierung, Backtester und Bot-Monitoring für Spot-Grid-Bots auf Binance-Kursdaten.

## Starten

Doppelklick auf `start.bat` (startet lokalen Server `server.py`, öffnet Browser). Alternativ manuell:

    python server.py 8080

Dann http://localhost:8080 öffnen.

## Tabs

**Analyse & Optimierung** — Währungspaar eingeben, Eignung für Grid-Trading prüfen (Preisspanne, Volatilität, Trend-Anteil der letzten 83 Tage), danach optionale Fein-Optimierung von Grid-Anzahl, Range, Stop-Loss und Take-Profit per Walk-Forward-Suche über historische Kerzen. Grid-Anzahl/Range/SL/TP werden dabei nicht nur auf einem Gesamtfenster optimiert, sondern über mehrere aufeinanderfolgende Zeitfenster (Folds) getestet — gewinnt nur, wer über mehrere Marktphasen konsistent funktioniert (0.6×Durchschnitt + 0.4×schlechtestes Fenster). Die Grid-Breite wird aus ATR(14) statt aus der reinen Min/Max-Spanne abgeleitet, das macht sie robuster gegen einzelne Ausreißer-Kerzen. Das beste Ergebnis lässt sich per Klick direkt als Bot ins Monitoring übernehmen.

**Backtest** — manueller, detaillierter Rücktest einer frei wählbaren Grid-Konfiguration mit Kerzenverlauf, Kennzahlen (Gesamtgewinn, realisiert/unrealisiert, Gebühren) und statistischem Trend-Ausblick.

**Bot-Monitoring** — eigene, aktuell laufende Bots hinterlegen (Paar, Grid-Anzahl, obere/untere Grenze, Startkurs, Startdatum). Per Klick auf „Alle Bots prüfen“ wird für jeden Bot verglichen, ob sich die Eignung des Paares seit dem Start verändert hat und ob der aktuelle Kurs noch innerhalb der Grid-Range liegt. Daraus ergibt sich pro Bot eine Empfehlung: **Weiter laufen lassen**, **Beobachten** oder **Stoppen**, sowie ein volatilitätsabhängiges empfohlenes Prüfintervall (täglich bis alle 1–2 Wochen). Die Bot-Listen (hinterlegte und entfernte Bots) werden im Browser (`localStorage`) und zusätzlich in `data/bots.json` im App-Ordner gespeichert (nur beim Start über `server.py`/`start.bat`; beim Laden gewinnt der neuere Stand).

## Technische Hinweise

- Handelspaare und Kerzen kommen live von der Binance Public API (kein API-Key), mit automatischem Fallback zwischen `api.binance.com` und `data-api.binance.vision`.
- Fee: 0.1 % pro Trade (fest, `FEE` in `app.js`).
- Backtest-Tab: Kerzengrösse wird automatisch gewählt (max. ~8000 Kerzen), Kerzenpfad Open → Low → High → Close (grüne Kerze) bzw. Open → High → Low → Close (rote Kerze).
- Analyse/Optimierung & Monitoring verwenden ein vereinfachtes Backtest-Modell (Kerze-für-Kerze-Prüfung ohne Pfad-Simulation). Die beiden Backtest-Engines liefern daher nicht zwingend identische Ergebnisse für dieselbe Konfiguration — siehe Liste der gefundenen Unstimmigkeiten, separat mitgeteilt.
