# Spieldesign

Dieses Dokument hält fest, **warum** die Systeme so gebaut sind. Es ist als
Arbeitsgrundlage für die Weiterentwicklung gedacht, nicht als Verkaufstext.

---

## Die Kernschleife

```
Ausrüsten  →  Absetzen  →  Beute sichern  →  Extrahieren  →  Verwerten
    ▲                            │                              │
    └────────────── oder sterben und alles verlieren ───────────┘
```

Alles im Prototyp dient einer einzigen Frage: **„Nehme ich das mit, oder gehe
ich jetzt raus?“** Jedes System, das diese Frage nicht schärft, gehört nicht
hinein.

Deshalb:

- Beute ist erst dann *deine*, wenn du stillstehend, exponiert, an einem
  bekannten Ort mehrere Sekunden ausgeharrt hast.
- Gier kostet buchstäblich Tempo, weil Gewicht auf Geschwindigkeit und Ausdauer
  wirkt.
- Die Einsatzuhr läuft weiter, während du im Inventar bist.

---

## Risiko und Belohnung

### Was du verlierst

Bei Tod oder Abbruch bleibt alles im Sektor, außer dem Inhalt des
Sicherheitsbehälters. Der Behälter ist klein genug, dass ein verlorener Einsatz
weh tut, und groß genug, dass man nie *alles* verliert – das ist das
Ventil, das verhindert, dass Spieler nur noch nackt loslaufen.

### Versicherung

Die Versicherung löst ein konkretes Problem: In einem Spiel, in dem der Tod
alles kostet, hören Spieler auf, gute Ausrüstung mitzunehmen. Sie horten sie,
laufen mit Minimalausrüstung und die Kämpfe werden schlechter.

Die Lösung macht einen *schlechten* Einsatz überlebbar, ohne einen *verlorenen*
schmerzfrei zu machen:

- Prämie im Voraus, pro Gegenstand.
- Rückgabequote deutlich unter 100 %, und sie **sinkt mit dem Wert**. Billige
  Ausrüstung kommt fast immer zurück, eine Spitzen-Plattenweste selten.
- Nichts kommt sofort zurück. Wer sein Sturmgewehr verliert, läuft den nächsten
  Einsatz mit der Zweitwaffe.
- Wer überlebt, hat die Prämie umsonst gezahlt.

### Ausgänge

Vier Ausgänge, bewusst ungleich:

| Ausgang | Bedingung | Designabsicht |
| --- | --- | --- |
| Frei | keine | Garantiert lösbaren Einsatz, liegt weit weg |
| Gebühr | Geld | Wer Bargeld gefunden hat, kauft sich einen kürzeren Weg |
| Schlüssel | Fundgegenstand | Belohnt Erkundung in vorherigen Einsätzen |
| Zeitfenster | zweite Hälfte | Verhindert Ausgangscamping ab Minute eins |

Startpunkte liegen möglichst weit von allen Ausgängen entfernt, damit
Extraktion immer eine Reise ist.

---

## Munition ist die tiefste Stellschraube

Dieselbe Waffe ist eine andere Waffe, je nachdem was im Magazin steckt. Die
Regel ist die realistische: **Schaden gegen Durchschlag**.

- Weichkerngeschosse zerlegen ungeschützte Ziele und bleiben an einer Platte
  hängen.
- Hartkerngeschosse gehen durch, hinterlassen aber einen kleineren Wundkanal.

Waffen selbst tragen **keinen** Schaden. Ihre Identität ist Rückstoß,
Rückkehrverhalten, mechanische Präzision, Handhabung und Nachladezeit. Damit
ist die Wahl zwischen einem handlichen Karabiner und einem schweren
Schlachtgewehr eine echte Entscheidung statt einer Aufrüstungsstufe.

### Panzerung

Panzerung ist die andere Hälfte derselben Gleichung. Schutzklasse 4 hält fast
alles Billige auf und fast nichts Teures. Weil Platten sich abnutzen, kostet
auch ein gewonnener Kampf etwas – dieser Druck macht lange Einsätze auch dann
gefährlich, wenn man gut ausgerüstet gestartet ist.

---

## Verletzung verändert das Spiel, nicht nur eine Zahl

Getrennte Körperteile statt einer Lebensleiste, weil jede Verletzung anders
spielt:

- Beintreffer bremsen dich.
- Armtreffer ruinieren dein Zielen.
- Kopf und Brust sind tödlich; alle anderen Gliedmaßen fallen aus und bluten
  Schaden in die Brust.

Zerstörte Gliedmaßen heilen im Feld **nicht**. Nur ein Chirurgieset bringt sie
teilweise zurück – ein schlechter Kampf hat damit Folgen, die dich bis zum
Ausgang begleiten.

Blutungen sind Zeitgeber, keine Statuswerte. Eine starke Blutung tötet in
ungefähr einer Minute – lang genug, um „jetzt behandeln oder jetzt rennen“ zu
einer echten Entscheidung zu machen.

Jeder medizinische Gegenstand deckt ein *anderes* Problem ab: Verband gegen
leichte Blutung, Abbindesystem gegen starke, Schiene gegen Bruch,
Erste-Hilfe-Set gegen Schaden, Chirurgieset gegen Verlust. Eine vollständige
Medizinausrüstung kostet daher echten Platz – genau die Spannung, die beim
Packen entstehen soll.

---

## Gegner

Schwierigkeit wird über **menschliche Grenzen** ausgedrückt, nicht über
Statuswerte: wie lange jemand braucht, dich zu bemerken, wie schnell er
anlegt, wie diszipliniert er feuert, wie bereit er ist, Deckung zu verlassen.

Ein erfahrener Gegner ist gefährlich, weil er schnell reagiert und sich gut
bewegt – nicht weil seine Kugeln mehr wehtun. Die Ballistik ist für alle
identisch.

| Stufe | Charakter |
| --- | --- |
| Streuner | Sprüht, gerät in Panik, schlecht ausgerüstet, verschlissene Waffen |
| Wachmann | Nutzt Deckung, feuert kontrolliert, brauchbare Ausrüstung |
| Söldner | Springt zwischen Deckungen, unterdrückt, flankiert, gute Munition |
| Kommandant | Drückt aggressiv, schwer gepanzert, hält die zentrale Halle |

Wahrnehmung ist ein Aufbau: Im Hellen auf zehn Metern stehend bist du in
Sekundenbruchteilen entdeckt; im Schatten auf dreißig Metern kriechend
vielleicht nie. Damit hat der Spieler echte Kontrolle darüber, gesehen zu
werden.

---

## Fortschritt

Zwei getrennte Kurven:

- **Stufe** ist das grobe Tor. Sie schaltet Händlerränge und Versteckmodule
  frei und wächst durch alles.
- **Fertigkeiten** wachsen durch **Benutzung**, nicht durch Punktevergabe. Wer
  sprintet, wird ausdauernder; wer schwer trägt, wird kräftiger. Es gibt keine
  falsche Verteilung, die man später bereut.

Fertigkeitseffekte liegen bewusst niedrig (20–30 % im Maximum). Sie sollen
Ecken abschleifen, nicht Positionierung und Vorbereitung ersetzen.

---

## Versteck

Ohne Basis ist alles außer Waffen nur Währung. Das Versteck macht aus Schrott
Entscheidungen: Metallschrott und Kabel sind beim Händler wertlos, aber der
einzige Weg zu mehr Lagerfläche. Treibstoff ist schwer und billig – ohne ihn
läuft der Generator nicht.

Ausbauten brauchen echte Zeit. Das ist Absicht: Man startet einen Ausbau und
geht einen Einsatz laufen, statt in Menüs zu sitzen. Der Fortschritt läuft auch
bei geschlossener App weiter, gedeckelt auf zwölf Stunden.

---

## Händler

Vier eigenständige Figuren mit jeweils eigenem Fachgebiet. Sie existieren, damit
Geld eine **Richtung** bekommt: Ein Gewehr beim Mediziner zu verkaufen ist
schlecht, bei der Waffenhändlerin gut. Ruf steigt durch Geschäfte und schaltet
besseren Bestand frei, weshalb Spieler sich natürlich spezialisieren – und
Spezialisierung erzeugt den Druck, Einsätze für bestimmte Dinge zu laufen.

---

## Aufträge

Aufträge lenken, *wohin* der Spieler geht und *wie* er spielt. „Fünf
Kopftreffer“ verändert die Art zu kämpfen, „über den Kanalsteg extrahieren“
verändert die Route, „drei medizinische Gegenstände abgeben“ verändert, was man
aufhebt.

Bei Tod werden nur einsatzgebundene Ziele zurückgesetzt (Überleben,
Extraktion). Bereits Abgegebenes bleibt erhalten – einen ganzen Auftrag an einen
schlechten Einsatz zu verlieren wäre Bestrafung ohne Lerneffekt.

---

## Dynamische Ereignisse

Ein ruhiger Extraction-Shooter ist ein langweiliger. Ereignisse zwingen einen
Spieler, der sich eingerichtet hat, zu einer Entscheidung:

- **Versorgungsabwurf** – Belohnung an angekündigter Position, also auch für
  alle anderen sichtbar.
- **Patrouille** – nimmt den sicheren Weg weg.
- **Stromausfall** – nimmt Sichtlinien und gibt sie dem, der näher steht.
- **Verstärkung** – deine Position wurde gemeldet.
- **Kommandant in Bewegung** – der Boss verlässt sein Depot.

Jedes Ereignis wird angekündigt. Es soll eine Wahl sein, kein Hinterhalt.
Höchstens drei pro Einsatz, mit Abstand dazwischen: unvorhersehbar ist gut,
unerbittlich nicht.

---

## Was bewusst fehlt

- **Kein PvP, keine Server.** Reine PvE-Machbarkeitsstudie.
- **Keine Minikarte, keine Gegnermarkierungen.** Wo Kontakte sind, verraten
  Ohren und Augen. Die Sektorkarte zeigt nur Gelände, und nur das bereits
  begangene.
- **Kein Speichern mitten im Einsatz.** Ein Raid läuft zu Ende. Ein Notausstieg
  aus einer schlechten Lage würde die gesamte Prämisse aushebeln.
