# GRAYZONE PROTOCOL

Ein mobiler PvE-Extraction-Shooter als **technischer Prototyp**. Vollständig
eigenständige Umsetzung: eigener Code, eigene prozedural erzeugte Assets, eigene
Namen, Karten, Systeme und Texte. Keine Inhalte Dritter.

Der Prototyp ist eine Machbarkeitsstudie für die Gameplay-Systeme des Genres und
als Grundlage für eine spätere Unity-Umsetzung gedacht. Der Fokus liegt auf den
Systemen, nicht auf der Grafik – die Darstellung ist bewusst Platzhalter, aber
technisch echt: perspektivische Ich-Sicht, materialabhängige Ballistik,
räumlicher Ton.

```
Plattform    Android / iOS (WebView via Capacitor), Desktop-Browser zum Testen
Steuerung    Touch (Dual-Stick + Tasten), Maus/Tastatur als Entwickler-Fallback
Ausrichtung  Querformat
Bildrate     60 FPS Ziel, adaptive Auflösungsskalierung
Netzwerk     keines – vollständig offline, Singleplayer, ausschließlich PvE
```

---

## Schnellstart

```bash
npm install
npm run dev          # Entwicklungsserver mit Hot Reload
```

Dann im Browser öffnen (bei Handytests: `--host` ist bereits aktiv, die
Netzwerk-URL steht in der Konsole).

```bash
npm run typecheck    # TypeScript ohne Emit
npm run test         # Simulationstests (89 Tests, Node Test Runner)
npm run viewports    # Layoutprüfung auf fünf echten Telefongrößen
npm run build        # Produktionsbundle nach dist/
npm run verify       # typecheck + test + build
npm run preview      # Produktionsbundle lokal ausliefern
```

### Browser-Smoke-Test

Fährt eine vollständige Sitzung in echtem Chromium durch – neues Profil, alle
Versteck-Reiter, Einsatz, Kampf, Beute, Karte, Abbruch, Auswertung, Speichern
und Laden – und schlägt bei jedem Seitenfehler fehl.

```bash
npm run build && npm run preview &
node tests/smoke.mjs --out ./dist/smoke
```

Benötigt Playwright (`npm i -D playwright`). Screenshots landen im `--out`-Ordner.

---

## Steuerung

### Touch

| Bereich | Funktion |
| --- | --- |
| Linke Bildhälfte | Bewegungsstick (erscheint, wo der Daumen aufsetzt). Weit nach vorn drücken = sprinten |
| Rechte Bildhälfte | Ziehen zum Umsehen (beim Zielen automatisch feinfühliger) |
| FEUER / ZIEL | Schießen und Anschlagen |
| LADEN / MODUS | Nachladen bzw. Ladehemmung beheben, Feuermodus wechseln |
| HALT / WECHS / MED | Haltung wechseln, Waffe wechseln, Medizin anwenden |
| LAMPE | Waffenlampe ein- und ausschalten |
| Zurück-Geste | Schließt den obersten Bildschirm, verlässt nie das Spiel |
| AKTION | Behälter durchsuchen, Leiche plündern |
| ◀ ▶ | Nach links/rechts lehnen |
| INV / KARTE / MENÜ | Inventar, Sektorkarte, Pausenmenü |

### Tastatur (nur zum Entwickeln)

`WASD` bewegen · `Shift` sprinten · Maus umsehen (Klick auf das Bild aktiviert
die Mauszeigerbindung) · `LMB` feuern · `RMB` zielen · `R` nachladen ·
`C` Haltung · `F` Aktion · `Q` Waffe wechseln · `V` Feuermodus · `H` Medizin ·
`E` lehnen · `L` Waffenlampe · `Tab` Inventar · `M` Karte · `Esc` Pause

---

## Was drin ist

**Einsatz.** Zeitlich begrenzte Raids auf drei prozedural erzeugten Karten mit
Startpunkten, vier Ausgängen (einer frei, einer gegen Gebühr, einer per
Schlüssel, einer nur in der zweiten Hälfte), Haltezeit an der Extraktion und
vollständigem Ausrüstungsverlust bei Tod oder Abbruch.

**Händler als Menschen.** Jeder Händler und Auftraggeber hat ein eigenes,
prozedural gezeichnetes Porträt - eine Art Dossierfoto mit hartem Seitenlicht,
Duotone, Korn und Scanlines. Vier Originalfiguren, keine Bilddateien im Projekt.

**Das Versteck als Ort.** Der Ausbau ist kein Modulzettel, sondern ein
gezeichneter Querschnitt der Anlage: unausgebaute Räume sind dunkler Fels mit
Schutt, laufende Ausbauten haben Gerüst und Arbeitslampe, fertige sind
beleuchtet und mit modulspezifischer Einrichtung gefüllt, die mit der Stufe
sichtbar wächst. Räume werden angetippt.

**Tageszeit und Wetter.** Die Absetzzeit wählt der Spieler (Tag, Morgengrauen,
Abenddämmerung, Nacht), das Wetter würfelt der Einsatz-Seed (klar, bedeckt,
Nebel, Regen, Sturm). Beides steuert dieselben Multiplikatoren: Helligkeit der
Karte, Nebeldichte und -farbe, Himmel, Sichtweite der KI, Reichweite von
Geräuschen und die Auszahlung. Nacht im Sturm zahlt rund 75 % mehr – und ist
genau so viel schwerer.

**Waffenlampe.** Ein echter Lichtkegel in der Szene, der Boden, Wände und
Gegner beleuchtet und von Geometrie verdeckt wird. Eingeschaltet macht er den
Spieler für die KI deutlich auffälliger und verlängert deren Entdeckungsreichweite
um bis zu 90 %, skaliert mit der Dunkelheit. Der Schalter ist die Entscheidung.

**Ballistik.** Echte Projektile mit Mündungsgeschwindigkeit, Luftwiderstand,
Schwerkraft und Flugzeit. Materialabhängige Durchschlagsleistung durch dieselben
Kacheldaten, die der Renderer zeichnet. Panzerungsdurchschlag als
Wahrscheinlichkeitskurve gegen Schutzklasse und Restzustand, Trefferzonen,
Fragmentierung, Blutungen und Brüche.

**Waffen.** Feuermodi, Rückstoß mit Erhitzung, Streuung aus Waffe, Munition,
Haltung, Bewegung und Verletzungen, Magazinwechsel gegen Einzelladung,
Ladehemmungen bei verschlissenen Waffen, Anbauteile (Dämpfer, Optiken, Griffe,
Schäfte, Lampen) mit echten Zielkonflikten.

**Gesundheit.** Getrennte Körperteile, leichte und starke Blutungen, Brüche,
Schmerz, zerstörte Gliedmaßen (nur chirurgisch wiederherstellbar), Energie und
Flüssigkeit – alles wirkt auf Tempo, Zielruhe und Ausdauer.

**Inventar.** Rasterinventar mit Rotation und Stapeln, Trageweste, Rucksack,
Taschen und ein Sicherheitsbehälter, der den Tod überlebt. Gewicht bestimmt
Tempo und Ausdauerverbrauch.

**KI.** Vier Stufen, unterschieden durch menschliche Grenzen statt Boni:
Reaktionszeit, Erfassungsdauer, Feuerdisziplin, Deckungsverhalten. Wahrnehmung
baut sich über Entfernung, Licht, Haltung und Bewegung auf; Gehör liefert eine
ungenaue Position. Verhalten umfasst Patrouille, Untersuchen, Gefecht,
Deckungswahl, Flankieren, Unterdrückung und Rückzug. Trupps teilen Kontakte.
Ein Bosskämpfer mit Leibwache hält die zentrale Halle.

**Beute und Wirtschaft.** Gewichtete Lootlisten je Behältertyp mit
Seltenheitsbändern nach Zonengefahr, Leichenplünderung, vier Händler mit Ruf und
Bestand, Aufträge, Versicherung mit wertabhängiger Rückgabequote.

**Versteck.** Sechs Module (Generator, Lager, Werkstatt, Medizinstation, Küche,
Sicherheitszentrale) mit echten Bauzeiten, Fertigung, Reparatur und
Zwischen-Einsatz-Heilung. Fortschritt läuft auch bei geschlossener App weiter.

**Ton.** Vollständig zur Laufzeit synthetisiert – keine Audiodateien.
Schussgeräusche aus Körper, Knall und Nachhall; Dämpfer entfernt den Knall.
Entfernung, Richtung und Wandverdeckung bestimmen den Mix.

---

## Projektstruktur

```
src/
  core/        Schleife, Mathematik, RNG, Ereignisbus, Pools, Raumgitter
  data/        Gegenstände, Waffen, Munition, Anbauteile, Ausrüstung, Karten
  world/       Kachelkarte, Kartengenerator, DDA-Raycast, Navigation, Physik,
               Einsatzbedingungen (Tageszeit und Wetter)
  render/      Software-Raycaster, prozedurale Texturen und Sprites, Effekte
  player/      Spielerfigur, Bewegung, Haltung, Ausdauer
  input/       Touch- und Tastatureingabe
  weapons/     Waffenauflösung und Feuer-/Nachladelogik
  combat/      Ballistik, Trefferzonen
  health/      Körperteile, Blutungen, Brüche, Stoffwechsel
  inventory/   Gegenstandsinstanzen, Rasterbehälter, Ausrüstung
  loot/        Lootlisten und Behälter
  ai/          Profile, Wahrnehmung, Verhalten, Direktor
  audio/       Prozedurale Klangerzeugung und Räumlichkeit
  raid/        Einsatzsitzung, Extraktion, dynamische Ereignisse
  meta/        Profil, Fortschritt, Händler, Aufträge, Versteck, Versicherung
  save/        Versionierte Persistenz
  ui/          Bildschirme, HUD, Inventaransicht
  game/        Anwendungsgerüst
tests/         Simulationstests und Browser-Smoke-Test
docs/          Architektur, Spieldesign, Unity-Portierung
```

Weiterführend: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md),
[`docs/UNITY_PORT.md`](docs/UNITY_PORT.md).

---

## Mobile Auslieferung

Das Bundle ist eine reine statische Web-App ohne externe Abhängigkeiten zur
Laufzeit und läuft unverändert in einem WebView.

```bash
npm i -D @capacitor/cli @capacitor/core
npm i @capacitor/android @capacitor/ios

npm run build
npx cap add android          # bzw. ios
npx cap sync
npx cap open android
```

`capacitor.config.ts` liegt bei und setzt Querformat, dunkle Statusleiste und
`dist` als Web-Verzeichnis.

---

## Leistung

Gemessen im Browser-Smoke-Test auf **reiner Software-Rasterisierung**
(SwiftShader, Container – also deutlich ungünstiger als echte Mobil-GPUs), bei
900x414 CSS-Punkten und Gerätepixelverhältnis 2:

```
59,6 FPS   Simulation 0,15 ms   Darstellung 10,6 ms   intern 1280x588   26 KI
```

Die Simulation belegt rund ein Prozent des 16,7-ms-Budgets. Praktisch die
gesamte Zeit geht in den Software-Raycaster und das Hochskalieren – beides ist
auf echter Hardware GPU-beschleunigt. Der Leistungsregler senkt die interne
Auflösung automatisch, wenn Bilder verpasst werden, und hebt sie langsam wieder
an; feste Stufen lassen sich in den Einstellungen wählen.

---

## Rechtliches

Sämtliche Inhalte dieses Prototyps sind eigenständig erstellt. Texturen, Sprites
und Klänge werden zur Laufzeit prozedural erzeugt; es sind keine Fremdassets
enthalten. Waffen-, Orts- und Personennamen sind frei erfunden.
Kaliberbezeichnungen sind allgemeine technische Normbezeichnungen.
