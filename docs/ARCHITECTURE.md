# Architektur

Dieses Dokument beschreibt, wie der Prototyp aufgebaut ist und **warum** – die
Entscheidungen, die eine spätere Unity-Portierung erleichtern oder erschweren
würden, sind bewusst so getroffen, dass der Simulationsteil unverändert
übernommen werden kann.

---

## Leitprinzipien

**1. Simulation kennt keine Darstellung.**
Kein Modul unter `world/`, `combat/`, `weapons/`, `health/`, `inventory/`,
`loot/`, `ai/`, `raid/` oder `meta/` importiert etwas aus `render/`, `ui/` oder
`audio/`. Kommunikation läuft ausschließlich über den Ereignisbus. Das ist der
Grund, warum sich die gesamte Spiellogik im Node-Testlauf ohne DOM ausführen
lässt – und warum sie in Unity ohne Anpassung weiterläuft.

**2. Ereignisse tragen Primitive, keine Objektreferenzen.**
`GameEvents.ts` definiert jede Nachricht mit IDs und Zahlen. Dadurch gibt es
keine Importzyklen, jedes Ereignis ist serialisierbar (Telemetrie, Wiedergabe),
und die Oberfläche kann Simulationszustand nicht versehentlich verändern.

**3. Keine Allokation im Dauerbetrieb.**
Geschosse, Partikel, Hülsen, Abdrücke und Klangereignisse stammen aus Pools mit
fester Obergrenze. Räumliche Abfragen laufen über ein Gitter aus typisierten
Arrays. Pausen durch die Speicherbereinigung sind auf Mobilgeräten die
häufigste Ursache für Ruckler – deshalb ist das eine Architekturregel und keine
Optimierung im Nachhinein.

**4. Ein Seed, ein Einsatz.**
Alle Zufallsentscheidungen laufen über gesetzte Ströme (`Rng`), nie über
`Math.random`. Karte, Beute, KI-Ausrüstung und Ballistik sind aus dem Seed
reproduzierbar; kosmetische Effekte haben einen eigenen Strom, damit weniger
Partikel niemals das Spielergebnis verändern.

---

## Schichten

```
                 ┌──────────────────────────────────────────┐
   Darstellung   │  render/   ui/   audio/                   │  liest, schreibt nie
                 └───────────────▲──────────────────────────┘
                                 │  Ereignisbus (nur Primitive)
                 ┌───────────────┴──────────────────────────┐
   Spiellogik    │  raid/  ai/  combat/  weapons/  health/   │
                 │  inventory/  loot/  player/  meta/        │
                 └───────────────▲──────────────────────────┘
                                 │
                 ┌───────────────┴──────────────────────────┐
   Fundament     │  world/   data/   core/   save/           │
                 └──────────────────────────────────────────┘
```

`game/Game.ts` ist das Anwendungsgerüst darüber: es besitzt die Schleife, den
Bildschirmstapel und die Systeme, die einen Einsatz überdauern (Eingabe, Ton,
Speicherstand, Profil). Eine `RaidSession` wird beim Absetzen erzeugt und bei
der Auswertung verworfen – dadurch kann kein Einsatzzustand in die Metaebene
lecken, außer über `RaidResult`.

---

## Kernschleife

`core/Loop.ts` trennt Simulation und Darstellung:

- **Feste Schrittweite (60 Hz).** Rückstoß, Ballistik und KI-Zeitgeber müssen
  auf einem 60-Hz-Telefon und einem 120-Hz-Tablet identisch ablaufen.
- **Nachholschritte begrenzt.** Nach einer Blockade wird der Rückstand
  verworfen statt aufgeholt – sonst entsteht eine Todesspirale.
- **Darstellung so schnell wie möglich**, mit `alpha` für Interpolation.

Die Reihenfolge pro Tick ist bewusst gewählt:

1. Eingabe abfragen (genau eine maßgebliche Stichprobe)
2. Eingabe auf den Spieler anwenden
3. Welt simulieren (KI, Ballistik, Ereignisse)
4. Oberfläche aktualisieren (liest nur)

Schritt 2 vor Schritt 3 – umgekehrt würde der Spieler auf eine ein Bild alte
Welt reagieren, was sich in einem Shooter sofort bemerkbar macht.

### Leistungsregler

`PerfGovernor` misst die tatsächlichen Bildkosten und verstellt die **interne**
Auflösung zwischen 45 % und 100 %. Er reagiert bewusst asymmetrisch: bei
verpassten Bildern fällt er schnell und in großen Schritten, zurück nach oben
geht es langsam und in kleinen. Eine schwankende Auflösung stört mehr als eine
etwas zu niedrige.

---

## Welt

Die Welt ist ein gleichmäßiges Kachelgitter. Eine Kachel ist zwei Meter breit;
Spiellogik rechnet in Kacheln, Ballistik rechnet in Metern.

Alle Kacheldaten liegen in parallelen typisierten Arrays (`tiles`, `floor`,
`ceiling`, `lightmap`, `lampLight`, `zoneGrid`) statt in Objekten – genau diese Felder
werden vom Raycaster, der Navigation und der Beleuchtung in inneren Schleifen
abgetastet.

Jedes Material trägt spielrelevante Eigenschaften: Durchschlagswiderstand,
Energieverlust, Schallschluckung, Deckungshöhe, Bewegungskosten und
Schrittlautstärke. **Der Renderer und die Ballistik lesen dieselbe Tabelle** –
die Wand, die gezeichnet wird, ist die Wand, die das Geschoss trifft.

### Kartenerzeugung

`MapGenerator` erzeugt aus einem Bauplan und einem Seed eine vollständige Karte:
Gebäude mit per BSP unterteilten Räumen, Containergassen, Zäune mit Toren,
Streugut, Zonen, Ausgänge, Startpunkte, Patrouillen und Beuteanker.

Danach läuft eine **Zusammenhangsprüfung**: Zufällige Zäune, Streugut und
Gebäude können in Kombination eine Ecke abschneiden, was einen Einsatz
unlösbar machen würde. Statt den Generator so weit einzuschränken, dass das nie
passieren kann (und dabei die interessanten Layouts zu verlieren), wird der
Fall erkannt und ein Durchbruch geschlagen – mit Materialkosten, die einen
Maschendrahtzaun vor einer Betonwand bevorzugen. Startpunkte, Patrouillen und
Beute werden anschließend auf die Hauptregion beschränkt.

### Beleuchtung und Bedingungen

Die Beleuchtung ist zweigeteilt, und zwar aus einem praktischen Grund: Der teure
Anteil ist der Sichtbarkeitstest pro beleuchteter Kachel, und der hängt nicht
davon ab, wie hell der Himmel ist.

- `bakeLighting` backt einmal pro Einsatz den **Lampenanteil** in `lampLight`,
  jeweils mit Sichtlinientest, damit Licht nicht durch Wände blutet.
- `applyConditions` faltet daraus und dem Himmelslicht der aktuellen
  Tageszeit die `lightmap`. Das ist ein linearer Durchlauf und kann jederzeit
  erneut laufen.

Straßenlaternen werden nachts **nicht** mit heruntergeregelt. Eine beleuchtete
Fläche unter schwarzem Himmel ist der gefährlichste Boden der Karte – das
funktioniert nur, wenn der Scheinwerfer hell bleibt, während alles andere
dunkel wird.

`Conditions` ist die einzige Tabelle, die Tageszeit und Wetter beschreibt.
Renderer, KI-Wahrnehmung, Schallausbreitung und Auszahlung lesen dieselben
Multiplikatoren. Kartenlayout ist davon unberührt: derselbe Seed erzeugt
denselben Boden unter jedem Himmel.

### Navigation

Zwei Werkzeuge für zwei Probleme:

- **A\*** für individuelle Ziele (diese Deckung, jenes Geräusch). Teuer,
  deshalb pro Bild budgetiert – ein Telefon verträgt keine zwanzig gleichzeitigen
  Suchen. Abgelehnte Anfragen werden im nächsten Denkschritt wiederholt; das
  Verhalten degradiert weich statt die Bildrate.
- **Flussfeld** für „alle in Richtung Spieler“. Ein Durchlauf liefert für jede
  Kachel eine Richtung, die beliebig viele KI kostenlos lesen. Es wird nur neu
  gebaut, wenn der Spieler die Kachel wechselt.

> **Hinweis für Wartung:** Die A\*-Implementierung nutzt eine geschlossene
> Menge. Das ist keine Optimierung: `decrease-key` ist als erneutes Einfügen
> umgesetzt, wodurch veraltete Duplikate im Haufen liegen, deren Ordnung nicht
> mehr zu ihrem `fScore` passt. Ohne das Schließen beim Entnehmen werden diese
> Duplikate erneut expandiert, die Suche dreht sich im Kreis und meldet gut
> erreichbare Ziele als unerreichbar. Die Oktil-Heuristik ist für den
> vorliegenden Kostenbereich konsistent, das Schließen also auch optimal.

Die `CoverMap` berechnet vorab für jede Kachel, aus welchen Himmelsrichtungen
sie gedeckt ist. Deckungssuche wird damit zu einem Tabellenzugriff statt zu
einem Strahlengewitter, sobald jemand beschossen wird.

---

## Darstellung

Ein Software-Raycaster, nicht weil es einfach ist, sondern aus drei Gründen:

1. Die Kosten skalieren mit der Bildschirmauflösung, nicht mit der
   Szenenkomplexität – eine volle Containergasse kostet so viel wie ein leeres
   Feld. Auf Mobilgeräten ist Vorhersagbarkeit mehr wert als Spitzenleistung.
2. Der Renderer durchläuft genau dasselbe Gitter wie die Simulation.
3. Ein vollständiger Tiefenpuffer fällt kostenlos an, was für die korrekte
   Verschachtelung von Sprites, Glas und Zäunen gebraucht wird.

Reihenfolge pro Bild: Himmel und Decke → Boden → undurchsichtige Wände →
Sprites (tiefengeprüft) → durchsichtige Flächen von hinten nach vorn.

Beleuchtung und Nebel werden **pro Spalte beziehungsweise pro Zeile** berechnet,
nicht pro Pixel: entlang einer Wandspalte und einer Bodenzeile sind sie konstant.
Die innere Schleife besteht damit aus drei Multiplikationen und einem Speichern.

Die Waffenlampe ist eine Ausnahme von der Regel „pro Spalte, pro Zeile“, und
zwar eine überlegte. Sie ist ein echter Kegel in der Szene, kein Bildschirm-
effekt: Sie addiert auf denselben Beleuchtungsterm, mit dem die Welt ohnehin
schattiert wird, und wird dadurch kostenlos von Geometrie verdeckt. Der
Kegeltest lebt im **Tangentenraum** – in dieser Projektion sind
`cameraX * planeLen` und `(y - horizon) / height` exakt die Tangenten der
Winkel zur Blickachse, ein Kreiskegel ist also ein Vergleich mit einem
quadrierten Radius, ganz ohne Trigonometrie. Auf Böden und Decken ist der
vertikale Anteil pro Zeile konstant; nur auf Wandspalten variiert er pro Pixel,
dort läuft der Test inline mit einem frühen Ausstieg außerhalb des Kegels.

**Mipmaps** lösen das Flimmern an seiner Wurzel. Ein Raycaster tastet einen
Texel pro Bildschirmpixel ab; auf Distanz deckt eine Wand weniger Pixel ab als
sie Texel hat, also wechselt der getroffene Texel bei jeder Kamerabewegung –
die Textur kriecht. Für jede Textur liegt eine vorgefilterte Kette (64 → 1)
bereit, und die Stufe ergibt sich direkt aus der Texeldichte, die die
Zeichenschleife ohnehin berechnet. Anders als ein pauschaler Weichzeichner
kostet das in der Nähe nichts, wo die Textur scharf sein soll.

**Nachbearbeitung** läuft auf dem internen Puffer, nicht auf der Anzeige –
ein Viertel der Pixel. Zwei Effekte, beide aus demselben Grund gewählt: sie
trennen ein berechnetes Bild von einem fotografierten.

- **Belichtungskurve.** Der Renderer addiert Licht (Lichtkarte + Mündungsfeuer
  + Lampe + Blitz) und schnitt bei 255 ab. Abschneiden ist der Grund, warum
  helle Flächen wie Farbe aussehen: alles darüber fällt auf denselben Wert
  zusammen. Eine filmische Kurve rollt stattdessen aus.
- **Lichtstreuung.** Echte Objektive streuen, und das Auge liest diese
  Streuung stärker als den Pixelwert selbst – deshalb sieht eine Lampe mit
  Bloom beleuchtet aus und ohne wie ein hellgraues Rechteck.

Der Bloom-Composite überspringt Blöcke ohne Helligkeit. Bloom ist im
typischen Bild fast überall null; dieser eine Test pro 4×4-Block ist der
Unterschied zwischen 27 ms und 3 ms.

Die Präsentation nutzt zwei Zeichenflächen: der Raycaster schreibt in ein
`ImageData` in interner Auflösung, das skaliert auf die sichtbare Fläche
übertragen wird; Waffenmodell, Fadenkreuz und Bildschirmeffekte werden danach
als Vektorgrafik darüber gezeichnet und bleiben dadurch bei jeder internen
Auflösung gestochen scharf.

Alle Texturen und Sprites entstehen beim Start prozedural. Stark
hochfrequente Materialien werden einmal weichgezeichnet – der Renderer tastet
ohne Mipmaps genau einen Texel pro Pixel ab, und einzelne kontrastreiche Texel
werden auf Distanz zu kriechendem Rauschen.

---

## Kampf

Geschosse sind echte Objekte, kein Hitscan. Das kauft drei Dinge: Flugzeit
(Vorhalten wird nötig), ehrliche Deckung (Energieverlust beim Durchschlag statt
Alles-oder-nichts) und Munition mit Bedeutung (Durchschlag gegen Schutzklasse
als lernbare Wahrscheinlichkeitskurve).

`Combatant` ist die gemeinsame Schnittstelle. Spieler und KI durchlaufen
denselben Schadenspfad, dieselbe `WeaponController`-Zustandsmaschine, dieselben
Nachladezeiten und dieselben Ladehemmungen. Es gibt keine Asymmetrie, um die
herum balanciert werden müsste.

---

## KI

Ein niederfrequenter „Denkschritt“ (5–6 Hz je nach Stufe) für Entscheidungen,
volle Simulationsrate für Bewegung, Zielen und Feuern. Die teuren Anteile –
Deckungsbewertung, Wegsuche – laufen nur wenige Male pro Sekunde und nur für
tatsächlich beteiligte Gegner.

Der `AIDirector` sorgt für drei Dinge: Budgetierung der Wegsuche,
Detailstufen (entfernte, ahnungslose Gegner ticken seltener oder gar nicht) und
Trupps, die Kontakte teilen. Koordinierte Vorstöße entstehen dadurch ohne
zentralen Planer.

Wahrnehmung ist ein Aufbau, kein Schalter: Entfernung, Licht (dieselbe
Lightmap, die der Renderer nutzt), Haltung und Bewegung speisen einen Zähler.
Gehör liefert eine **absichtlich ungenaue** Position, deren Fehler mit der
Lautstärke sinkt – deshalb sind Schalldämpfer wertvoll und ein Sprint an einer
Patrouille vorbei ein echtes Wagnis.

---

## Speichern

Versioniert, mit Migrationskette. Unbekannte Gegenstands-IDs werden beim Laden
entfernt statt den Spielstand abzulehnen – eine Inhaltsänderung darf ein Profil
niemals unbrauchbar machen. Die ID-Zähler werden nach dem Laden hochgesetzt,
sonst kollidieren neue Gegenstände mit gespeicherten.

Schreibvorgänge sind entprellt, weil `localStorage` synchron ist und ein
Schreiben mitten im Bild auf Mobilgeräten sichtbar ruckelt.

---

## Tests

- **`tests/simulation.test.ts`** – 89 Tests über Determinismus, Geometrie,
  Navigation, Inventarbuchführung, Schadensmodell, Wirtschaft, Einsatz-
  bedingungen und Wahrnehmung unter Licht und Wetter. Läuft ohne
  DOM über einen esbuild-Lader (Node kann Konstruktor-Parametereigenschaften
  nicht allein durch Typentfernung verarbeiten).
- **`tests/smoke.mjs`** – vollständige Sitzung in echtem Chromium mit
  Screenshots und Leistungsmessung. Fängt genau die Klasse von Fehlern, die
  Typprüfung und Einheitentests nicht sehen können („kompiliert, aber das Menü
  öffnet nicht“).
