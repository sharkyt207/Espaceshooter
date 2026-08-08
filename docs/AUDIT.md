# Audit

Stand nach dem Umbau. Dieses Dokument ist die Abschlussprüfung aus dem
Auftrag: **was wurde gebaut, was wurde gemessen, und was fehlt noch.**

Es ist bewusst unfreundlich zu sich selbst. Ein Audit, das nur auflistet, was
funktioniert, ist eine Verkaufsbroschüre. Die interessanten Zeilen stehen unten
unter „Was noch offen ist".

---

## Die wichtigste Erkenntnis dieses Durchgangs

Drei Systeme waren **vollständig gebaut und an nichts angeschlossen**. Sie
bestanden jede Prüfung, die den Code liest, und keine, die das Verhalten misst:

| System | Symptom | Ursache |
|---|---|---|
| KI-Bewegung | Gegner stand im Freien und schoss, den ganzen Kampf | `enterState()` löschte den gerade berechneten Pfad |
| Zielhilfe | Regler in den Einstellungen ohne jede Wirkung | `aimAssistActive` wurde gelesen, aber von nichts gesetzt |
| Sprung/Vault | Taste belegt, Funktion deklariert, nie verdrahtet | (in einem früheren Durchgang behoben) |

Das ist ein Muster, kein Zufall, und es hat eine Konsequenz für die Prüfstrategie:

> **Ein Test, der eine Funktion aufruft, prüft nicht, ob das Spiel sie aufruft.**

Deshalb misst der KI-Test jetzt die *Spur*, die ein Gegner über eine Karte
zieht, und nicht seinen Zustandsautomaten. Und deshalb hat die Zielhilfe drei
Prüfungen statt einer — zwei davon wären mit dem Fehler grün geblieben.

Belegt: Von den fünf KI-Prüfungen fallen drei auf dem alten Stand um und
bestehen auf dem neuen. Die Verdrahtungsprüfung der Zielhilfe fällt um, sobald
man die eine Zeile im Frame-Loop entfernt — nachgemessen, nicht behauptet.

---

## Steuerung — höchste Priorität laut Auftrag

| Anforderung | Stand | Nachweis |
|---|---|---|
| Echtes Multitouch, 3–4 Finger | erfüllt | Smoke-Test: vier gleichzeitige Zeiger, Laufen + Zielen + Feuern + ADS |
| Keine Eingabekonflikte | erfüllt | Rolle wird beim Aufsetzen vergeben und nie neu zugewiesen |
| Klauengriff 2/3/4/Custom | erfüllt | `applyPreset()`, jede Reglerbewegung schaltet auf `custom` |
| Buttongröße/-position/-transparenz | erfüllt | `ButtonLayout {x, y, size, opacity}` pro Button |
| Sensitivität, ADS, Zielfernrohr | erfüllt | drei getrennte Faktoren, Vergrößerung teilt zusätzlich |
| Gyroskop | erfüllt | additiv zum Daumen, nicht als Modus |
| Beschleunigung, Glättung | erfüllt | in `applyLook()`, feste Reihenfolge |
| Dezente, abschaltbare Zielhilfe | **in diesem Durchgang verdrahtet** | 0,400 → 0,340 rad bei gleicher Wischbewegung |
| Nicht invertiert | erfüllt | eigene Prüfung: runter heißt runter |

Die Zielhilfe verlangsamt die Drehung, während das Fadenkreuz auf jemandem
liegt. Mehr nicht. Sie bewegt das Zielen nicht, biegt keine Kugel und
vergrößert keine Trefferzone. Der Daumen schießt über ein entferntes Ziel
hinaus, weil die letzten Pixel Weg mehrere Grad wert sind; das Verlangsamen
gibt die Präzision zurück, die eine Maus hätte, ohne den Treffer zu schenken.

Das Fenster ist ein Winkel, kein Bildschirmradius: 0,34 rad Halbwinkel auf eine
Kachel, geteilt durch die Entfernung. Es wird mit der Entfernung genauso enger
wie das Ziel selbst.

---

## Gefecht

| Anforderung | Stand |
|---|---|
| Deutlich erweitertes Arsenal | 16 Waffen über 9 Klassen: Pistole, MP, Karabiner, Sturmgewehr, Schlachtgewehr, DMR, Scharfschütze, Schrot, MG |
| Waffen fühlen sich unterschiedlich an | Handhabungsleiter über alle Klassen, ohne Überschneidung — als Test formuliert |
| Echter Rückstoß, Können zählt | Deterministische Muster pro Waffe, aus der Waffen-ID erzeugt; erlernbar, nicht zufällig |
| Rückstoß-Reset | über Hitze, nicht über den Abzug |
| Anbauteile | 34, mit achsengetrennter Wirkung: Griff waagerecht, Schaft senkrecht |
| Körperteilschaden | 7 Zonen, Blutungen, Brüche, Durchschuss auf zerstörte Glieder |
| Munition, Kaliber | 42 Sorten, Penetration und Fragmentierung getrennt |

---

## Gegner

Der Auftrag nennt den Fehlerfall wörtlich: *„NPC sieht Spieler, rennt geradeaus
auf Spieler zu."* Genau das war der Zustand — schlimmer sogar, er rannte nicht
einmal.

Gemessen nach der Reparatur, ein Trupp aus drei Wachen gegen ein stehendes Ziel:

```
t= 0.0s  patrol      (26.5,10.5)   patrol      (26.5,11.5)   idle        (26.5,12.5)   Abstand 2.0
t= 4.0s  engage      (23.9, 9.9)   reposition  (22.5,14.1)   reposition  (18.8,12.5)   Abstand 5.7
t= 8.0s  reposition  (12.2,11.1)   engage      (10.0,12.6)   reposition  (17.7,13.9)   Abstand 7.8
t=12.0s  reposition  ( 8.9,13.6)   engage      ( 9.6, 9.8)   investigate (13.7,21.5)   Abstand 12.4
```

Sie fächern von 2 auf 12 Kacheln auf, nehmen unterschiedliche Wege, zwei von
drei enden auf Deckungsfeldern (Deckungswert 120 und 60), einer umgeht weit über
die Flanke. Kein Stapeln, keine gemeinsame Linie.

Vier Stufen: Streuner, Wache, Söldner, Kommandant. Sichtweiten 22/28/34/40
Kacheln. Trupps teilen Kontakte, aber schwächer als eine eigene Sichtung — man
läuft dorthin, wo der Partner ruft, man bekommt nicht seine Augen.

---

## Ton

Panning allein kann vorne nicht von hinten unterscheiden. Der korrekte
Platzierungssinus ist bei 90° vorne derselbe wie bei 90° hinten — dieselbe
Verwechslungszone, die echte Ohren haben. Gelöst wie echte Ohren es lösen: über
die Klangfarbe. Was von hinten kommt, ist hörbar dunkler (42 % Höhen) und
minimal leiser (88 %).

Verdeckung nutzt dieselbe Schätzung wie das Hörmodell der KI. Eine Wand ist für
beide Seiten eine Wand — das hält Ton als faire Informationsquelle.

---

## Grafik

Zwei vollständige Renderer, beide geprüft:

- **WebGL2** — Texture-Arrays, Instanzierung, Half-Float-Ziele, Tiefentextur,
  anisotrope Filterung, Normal Mapping aus Luminanz, Ambient Occlusion pro
  Vertex, Bloom über Ping-Pong-Framebuffer.
- **Software-Raycaster** als Rückfallebene.

Beide stimmen überein: Rangkorrelation 0,899 über 8×4 Helligkeitszellen.

Drei Stile, umschaltbar: **Comic**, **Futuristisch**, **Realistisch**. Echte
Cel-Bänder vor der Albedo-Multiplikation, Konturen aus zweiten Differenzen der
*reziproken* Tiefe — der einzige Ausdruck, der auf einer beliebigen Ebene
tatsächlich null ergibt. Drei frühere Versuche taten das nicht und zeichneten
brav das Kachelraster in die Perspektive.

---

## Leistung

Unter Dauerfeuer, alle 26 Gegner im Gefecht, gemessen im Browser:

```
Simulation  1,0 – 2,0 ms
Zeichnen    1,2 – 1,9 ms
```

Rund 3 ms von 16 ms Budget. Die Bildraten in der Prüfumgebung (6–15 fps) sind
**keine Geräteaussage**: dort rastert SwiftShader auf der CPU und braucht allein
für das Compositing etwa 100 ms je Bild.

---

## Umfang

| | |
|---|---|
| Quellzeilen TypeScript | 30 785 in 88 Dateien |
| Laufzeitabhängigkeiten | 0 |
| Waffen / Munition / Anbauteile | 16 / 42 / 34 |
| Ausrüstung / Verbrauchsgüter | 30 / 28 |
| Karten | 3 (96², 78², 66²) |
| Händler / Aufträge / Basismodule / Rezepte | 4 / 9 / 6 / 16 |
| Simulationstests | 141 |

---

## Prüfmittel

| Werkzeug | Prüft |
|---|---|
| `npm test` | 141 Simulationstests, ohne Browser |
| `tests/smoke.mjs` | Echtes Chromium, ganze Sitzung, 24 Aufnahmen |
| `tests/viewports.mjs` | 5 Geräte: Überlauf, zu kleine Ziele, **Überlappung** |
| `tests/renderers.mjs` | Beide Renderpfade im Vergleich |
| `tests/browser.mjs` | Findet den vorhandenen Chromium statt des erwarteten |

Eine Lehre, zweimal bezahlt: **`npm test` kann grün sein, während `tsc`
fällt.** Der Testlader entfernt Typen, ohne sie zu prüfen. `npx tsc --noEmit`
gehört vor jeden Commit.

---

## Was noch offen ist

Ehrlich, und nach Gewicht sortiert.

1. **Der Unity-Port ist zu einem Drittel fertig.** Kern und Weltschicht sind in
   C# übersetzt und getestet; Gegenstände, Inventar, Gesundheit, Ballistik,
   Waffen, KI, Beute und Metaspiel sind es nicht. Der Grund ist kein
   technischer: der Auftraggeber hat kein Gerät, auf dem sich ein Unity-Build
   verifizieren ließe, und ungetesteten Portcode zu schreiben hieße, Arbeit zu
   liefern, die niemand geprüft hat.

2. **Drei Karten sind für eine Extraktions-Schleife wenig.** Der Generator
   erzeugt sie prozedural aus Bauplänen, das Nachlegen ist billig — aber
   Wiedererkennbarkeit entsteht aus Handarbeit, und die fehlt.

3. **Die Prüfumgebung hat keine echte GPU.** Alle Grafikaussagen stammen von
   SwiftShader. Struktur und Übereinstimmung der Renderer sind damit belegt,
   Bildraten auf echten Telefonen nicht. Das ist die größte offene Unbekannte
   im ganzen Projekt.

4. **Inventarzellen sind auf kurzen Bildschirmen 32 px groß**, unter der
   üblichen Empfehlung von 44 px für Berührungsziele. Vertretbar, weil
   Gegenstände über mehrere Zellen reichen und Auswahl per Antippen statt
   Ziehen läuft — aber ein 1×1-Gegenstand bleibt ein kleines Ziel.

5. **Der Smoke-Test läuft gegen eine gesättigte Software-Rasterung.** Er hält
   den Loop für Aufnahmen an und wiederholt einmal; das ist Kompensation für
   die Umgebung, nicht für das Spiel. Auf einer Maschine mit GPU wäre nichts
   davon nötig.

---

## Eigenständigkeit der Inhalte

Alle Namen, Karten, Texte, Waffenbezeichnungen, Händler, Aufträge und
Oberflächen sind für dieses Projekt erfunden. Es gibt keine externen Assets:
jede Textur wird zur Laufzeit prozedural erzeugt, jeder Ton wird synthetisiert,
jedes Porträt wird gezeichnet. Das Projekt hat **null Laufzeitabhängigkeiten** —
es ist damit nachprüfbar, nicht nur behauptet.
