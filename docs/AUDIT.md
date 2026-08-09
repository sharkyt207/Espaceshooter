# Audit

Stand nach dem Umbau. Dieses Dokument ist die Abschlussprüfung aus dem
Auftrag: **was wurde gebaut, was wurde gemessen, und was fehlt noch.**

Es ist bewusst unfreundlich zu sich selbst. Ein Audit, das nur auflistet, was
funktioniert, ist eine Verkaufsbroschüre. Die interessanten Zeilen stehen unten
unter „Was noch offen ist".

---

## Die wichtigste Erkenntnis dieses Durchgangs

Mehrere Systeme waren **vollständig gebaut und an nichts angeschlossen**. Sie
bestanden jede Prüfung, die den Code liest, und keine, die das Verhalten misst:

| System | Symptom | Ursache |
|---|---|---|
| KI-Bewegung | Gegner stand im Freien und schoss, den ganzen Kampf | `enterState()` löschte den gerade berechneten Pfad |
| Zielhilfe | Regler in den Einstellungen ohne jede Wirkung | `aimAssistActive` wurde gelesen, aber von nichts gesetzt |
| Partikelbudget | Jedes Gerät erzeugte die volle Anzahl, egal wie schlecht es lief | `EffectSystem.quality` dokumentierte sich als „vom Governor gesenkt" und wurde nie gesenkt |
| Sprung/Vault | Taste belegt, Funktion deklariert, nie verdrahtet | (in einem früheren Durchgang behoben) |
| Munitionswahl | `preferredAmmo` wurde beim Nachladen ausgewertet und von nichts gesetzt | keine Oberfläche dafür — inzwischen gebaut |

Nachdem das Muster erkannt war, habe ich gezielt danach gesucht statt darauf zu
warten, wieder darüber zu stolpern: ein Scan über alle öffentlichen Felder, die
gelesen und nie geschrieben werden (oder umgekehrt). Ergebnis waren neben dem
Partikelbudget drei tote Regler, die inzwischen entfernt sind — `Loop.timeScale`
(mit dem falschen Kommentar „von Menüs benutzt"), `InputSystem.touchDetected`
und vier HUD-Callbacks, die neben der echten Verdrahtung herliefen und nichts
trugen.

Das ist ein Muster, kein Zufall, und es hat eine Konsequenz für die Prüfstrategie:

> **Ein Test, der eine Funktion aufruft, prüft nicht, ob das Spiel sie aufruft.**

Der jüngste Fall dieser Art war die **Extraktion selbst** — die Handlung, nach
der das Genre benannt ist. Ausgänge wurden auf Existenz und Erreichbarkeit
geprüft, und der Browser-Durchlauf *bricht* den Einsatz ab, statt durch einen zu
gehen. Die Abfolge, um die das ganze Spiel gebaut ist — etwas aufheben, zum
Ausgang tragen, den Ausgang halten, das Getragene behalten — war nie am Stück
gelaufen. Jeder Teil existierte; nichts prüfte, dass sie verbunden sind.

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
| Munitionswahl | **in diesem Durchgang gebaut** — pro Kaliber wählbar, im Profil gespeichert, wirkt beim nächsten Nachladen |

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

## Orte, die sich unterscheiden

Die drei Karten unterschieden sich **untereinander so wenig wie zwei Seeds
derselben Karte**: 25,8–29,2 % feste Fläche, mittlere Sichtweite 8,3–10,8 —
und fünf Seeds einer einzigen Karte spannten 8,9–10,8. Nichts war
wiedererkennbar. Ein vierter Bauplan hätte nur eine vierte austauschbare Karte
ergeben, deshalb kam vor dem Nachlegen die Messung.

Gemessen wird die **mittlere freie Sichtlinie im Freien** — die Zahl, die ein
Spieler fühlt, ohne sie benennen zu können: sie entscheidet, ob ein Zielfernrohr
sein Gewicht wert ist und ob das Überqueren offener Fläche eine Entscheidung
ist oder ein Spaziergang.

| Ort | Sicht draußen | über Seeds | innen | Gegner/1000 Kacheln | Dauer |
|---|---|---|---|---|---|
| Hafenbecken 7 | 14,0 | 12,3 – 15,1 | 14 % | 2,4 | 25 min |
| Umschlagdepot Nord | 7,6 | 6,9 – 8,2 | 14 % | 3,0 | 18 min |
| Klärwerk Ost | 8,0 | 7,6 – 8,3 | 33 % | 4,2 | 16 min |
| Verladehof 3 | 5,9 | 5,6 – 6,2 | 28 % | 7,4 | 8 min |
| Kesselhaus West | 4,7 | 4,6 – 5,0 | 27 % | 3,2 | 14 min |

Entscheidend bei den ersten dreien ist die dritte Spalte: **die Seed-Streuung
überlappt nicht mehr mit dem Abstand zwischen den Orten.** Ein Ort ist
unabhängig vom Seed wiedererkennbar, und genau das war vorher nicht so.

Die beiden neuen liegen bewusst *nicht* auf der Sichtachse — dort säßen sie auf
dem Depot und dem Kesselhaus. Sie besitzen eine eigene: das **Klärwerk** wird
drinnen ausgetragen (33 % überdachte Bodenfläche gegen 14 %) und liegt im
Dunkeln, der **Verladehof** ist die Risiko-Achse (dreifache Gegnerdichte, acht
Minuten). Jede dieser Behauptungen ist als Test formuliert, damit sie beim
nächsten Balancing nicht stillschweigend verloren geht.

Was jeder Ort ist, steht jetzt auch auf seiner Karte im Einsatzplaner. Vorher
erfuhr man es, indem man dort einmal starb — eine schlechte Art zu lernen, dass
das Zielfernrohr die falsche Wahl war.

Der wirksame Hebel ist `clutter` (11,1 → 4,6 über seinen Bereich). Ich hatte
zuerst einen `structureSpacing`-Parameter eingebaut, in der Annahme, der Abstand
zwischen Strukturen sei ausschlaggebend — gemessen bewegte er die Zahl von 7,3
auf 8,3 über den Bereich 2 bis 12 Kacheln. Vierzehn Prozent für einen Regler,
der aussieht, als forme er die Karte um. Er ist wieder draußen.

### Ein Fehler, den erst der fünfte Ort sichtbar machte

Die Gefahrenstufe einer Gebäudezone war `0.5 + i * 0.05` — **unbegrenzt**. Das
neunte Gebäude erreichte 0,90, das vierzehnte 1,15, überholte also das
Hauptgebäude. Solange kein Bauplan mehr als fünf Gebäude verlangte, fiel das nie
auf. Das Klärwerk mit vierzehn drehte den Risikogradienten der Karte um: auf dem
wertvollsten Boden standen *weniger* Gegner statt mehr.

Beim Nachmessen zeigte sich, dass die Verzerrung im Spawner ohnehin zu schwach
war. Die Spitzenzone bekam auf zwei der fünf Orte nur 0,67× und 0,83× ihres
Flächenanteils an Gegnern — die wertvollste Fläche der Karte war ihre leerste,
also genau die Umkehrung dessen, worauf die ganze Schleife beruht. Die Annahme
wurde quadriert (`0.15 + Gefahr² · 0.85`, rund vierfache Bevorzugung statt
1,8-facher); jetzt liegen alle fünf Orte zwischen 1,7× und 3,3×.

Der Test dazu brauchte drei Anläufe und jeder Fehlversuch steht im Quelltext:
ein Heiß-gegen-Ruhig-Vergleich maß die Form der Zonentabelle statt den Spawner
(die Zonen überlappen absichtlich), der Mittelwert über alle Spawns wurde von
den drei Vierteln unstrittigen Bodens erdrückt, und die erste brauchbare Fassung
behauptete eine statistische Eigenschaft aus einer einzigen Stichprobe von
sechzehn Gegnern.

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

**Und seit diesem Durchgang auch in der Helligkeit.** Die Rangkorrelation fragt
nur nach der *Reihenfolge* der Zellen, und eine gleichmäßige Abdunklung lässt
jede Reihenfolge unangetastet — genau deshalb ist folgendes durch jede bisherige
Prüfung gekommen: der Shader benutzte eine filmische Kurve, der Software-Pfad eine
Reinhard-Variante, deren Kommentar behauptete, sie lasse die Mitten „fast
unverändert". Bei mittlerem Grau lagen beide um fast den Faktor zwei
auseinander. Gemessen: das Software-Bild war **44 % dunkler** als das GPU-Bild
derselben Szene.

Wer auf dem Raycaster landete, spielte ein anderes, dunkleres Spiel — und bei
einem Nachteinsatz entscheidet das, was man sehen kann. Beide Pfade teilen
jetzt eine Kurve (Verhältnis 1,80 → 0,98), ein Unit-Test hält die
TypeScript-Fassung gegen die aus dem Shader-Quelltext gelesenen Konstanten, und
die Renderer-Prüfung misst zusätzlich die mittlere Helligkeit.

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
| Karten | 5 (96² bis 52²) |
| Händler / Aufträge / Basismodule / Rezepte | 4 / 9 / 6 / 16 |
| Simulationstests | 156 |

---

## Prüfmittel

| Werkzeug | Prüft |
|---|---|
| `npm test` | 156 Simulationstests, ohne Browser |
| `tests/smoke.mjs` | Echtes Chromium, ganze Sitzung, 24 Aufnahmen |
| `tests/viewports.mjs` | 5 Geräte: Überlauf, zu kleine Ziele, **Überlappung** |
| `tests/renderers.mjs` | Beide Renderpfade: Struktur, Spiegelung **und Helligkeit** |
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

2. **Fünf Karten sind für eine Extraktions-Schleife immer noch nicht viel.**
   Sie unterscheiden sich seit diesem Durchgang aber messbar (siehe unten), und
   das Nachlegen ist jetzt billig, weil der Bauplan Charakter steuert statt nur
   Größe. Die Obergrenze des Generators für Innenräume liegt bei rund einem
   Drittel der begehbaren Fläche — ein Ort, der fast vollständig innen spielt,
   bräuchte einen anderen Erzeuger.

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
