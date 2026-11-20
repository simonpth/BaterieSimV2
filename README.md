# Speicher-Auslegung aus KSEM-Messdaten

Statische Web-App, mit der sich die Größe eines stationären LiFePO4-Hausspeichers auf Basis von KSEM-Messdaten (PV-Einspeisung und Netzbezug, 10-Minuten-Mittel) auslegen lässt. Die Berechnung läuft vollständig im Browser, es werden keine Daten hochgeladen.

## Schritte

1. **Upload:** eine oder mehrere CSV-Dateien. Aneinandergehängte Wochenexporte werden getrennt, Duplikate entfernt. Ein Datenqualitäts-Bericht zeigt Lücken, Sommerzeit, Extremtage, Plausibilität usw.
2. **Rohdaten:** Leistung und Tagesenergie.
3. **Simulation:** Ladezustand für eine gewählte nutzbare Kapazität, Kennzahlen, Vollzyklen pro Monat, Wirtschaftlichkeit (Ersparnis, Amortisation, Gewinn über die Lebensdauer).
4. **Auswertung:** Kennwerte über der Kapazität:
   - Vollzyklen pro Jahr mit Grenzlinie Zyklenfestigkeit ÷ Kalenderlebensdauer und Schnittpunkten
   - vermiedener Netzbezug
   - Grenznutzen
   - Amortisation und Lebensdauer
   - Gewinn
   - Ergebnistabelle mit CSV-Export

Alle Einstellungen (Hochrechnung, Akku-Parameter, Kosten) stehen in der linken Leiste und wirken sofort. Ein `?` neben jedem Wert erklärt ihn.

Diagramme (uPlot):
- **Mausrad:** zoomen
- **Shift + Mausrad / horizontal wischen / Shift + Ziehen:** verschieben
- **Ziehen:** Bereich wählen
- **Doppelklick:** zurücksetzen

## Rechenmodell

- Schrittweise Simulation je 10-Minuten-Wert. Es fließen nur **Einspeisung (= Überschuss)** und **Netzbezug (= Defizit)** ein.
  - Laden: `min(Einspeisung · η_lade, C − SoC)`
  - Entladen: `min(Netzbezug / η_entlade, SoC)`
- Optional **Elektrowinde** mit eigenem Akku (Standard 120 kWh, zu Beginn voll). An jedem Samstag und Sonntag im gewählten Monatsbereich (Standard März–Oktober) läuft die Winde von 9 bis 19 Uhr (einstellbar). In dieser Zeit kann sie nicht geladen werden, und um 19 Uhr hat ihr Akku 30 kWh (einstellbar) weniger als um 9 Uhr. Sonst wird der Windenakku nur aus PV-Überschuss geladen, immer vor dem Hausspeicher. Ist er am Freitag vor einem Windenwochenende nicht voll, wird er aus dem Netz vollgeladen (nicht aus dem Hausspeicher).
- Vollzyklen = entnommene Energie (Zellseite) ÷ nutzbare Kapazität.
- Hochrechnung auf 365 Tage. Fehlende Tage werden mit dem Tagesmittel der letzten N Messtage aufgefüllt, alternativ mit erstem und letztem Block. Die Variante „Nur Messzeitraum“ zählt fehlende Tage als 0 und ist damit die konservative Untergrenze.
- Lebensdauer = `min(Zyklenfestigkeit ÷ Zyklen pro Jahr, Kalenderlebensdauer)`.
- Ersparnis = vermiedener Netzbezug × Strompreis − geladene PV-Energie × Einspeisevergütung.

## Lokal starten

ES-Module brauchen einen HTTP-Server:

```sh
python3 -m http.server 8000
# http://localhost:8000
```

Optional lädt `?src=datei.csv` eine CSV-Datei, die neben der Seite liegt.

## Test

Rechenkern gegen die Referenzwerte prüfen:

```sh
node test/check.mjs AnalyseJahr2026.csv
```

## GitHub Pages

Repository pushen, dann unter *Settings → Pages* als Quelle den Branch `main` und den Ordner `/ (root)` wählen. Es ist kein Build-Schritt nötig. uPlot liegt unter `vendor/`.

`*.csv` ist per `.gitignore` ausgeschlossen, damit die Messdaten nicht mit veröffentlicht werden.
