# Greyzone – Unity-Projekt

Portierung der Simulationsschicht des Web-Prototyps nach C#. Dieses Verzeichnis
ist ein vollständiges Unity-Projekt – du öffnest es direkt im Hub.

**Stand:** Fundament und Welt sind portiert und getestet, einschließlich der
Einsatzbedingungen (Tageszeit und Wetter). Kampf, Gegenstände, KI und Metaebene
folgen; sie liegen weiterhin als lauffähige Referenz im TypeScript-Prototyp
(`src/`).

---

## Öffnen

1. Unity Hub → **Add** → dieses `unity/`-Verzeichnis wählen.
2. Editor-Version: das Projekt ist mit **Unity 6000.0.32f1** markiert. Jede
   Unity-6-Version geht; der Hub bietet beim Öffnen ein Upgrade an.
3. Beim ersten Öffnen erzeugt Unity `Library/` und alle `.meta`-Dateien. Das
   dauert einen Moment und ist normal – beides ist absichtlich nicht im
   Repository.

## Mit deinem Cloud-Projekt verbinden

Das mache **du** im Editor; ich habe keine Zugangsdaten für dein Unity-Konto und
soll auch keine haben.

1. *Edit → Project Settings → Services*
2. Mit deinem Unity-Konto anmelden, Organisation wählen.
3. **Link project to an existing Unity project ID** → **Greyzone** auswählen.
4. Für das „Waiting for Diagnostic Data“ auf deinem Dashboard: *Project
   Settings → Diagnostics* aktivieren und einen echten Build erzeugen. Vorher
   kommen dort keine Daten an.

---

## Sofort etwas sehen

1. Neue Szene, leeres GameObject, Komponente **MapPreview** anhängen.
2. `Blueprint Id` auf `harbour`, `depot` oder `works` setzen.
3. Im Kontextmenü der Komponente **Rebuild** – oder `Seed` ändern, das Feld baut
   automatisch neu.

Die Karte entsteht aus Primitiven: graue Blöcke sind sichtblockierende Wände,
blaugraue sind durchsichtig aber schusshemmend (Zaun, Glas), braune sind
hüfthohe Deckung. Gizmos zeigen Ausgänge (grün), Spielerstartpunkte (orange),
Gegner (rot) und Patrouillenrouten (blau).

`MapPreview` ist ein Wegwerf-Visualisierer. Wenn echte Assets kommen, ersetzt du
den Kachel-Switch durch Prefab-Lookups; alles andere bleibt.

---

## Aufbau

```
Assets/Greyzone/
  Simulation/          engine-unabhängig, referenziert kein UnityEngine
    Core/              Mathematik, RNG, Ereignisbus, Pools, Raumgitter, IDs
    World/             Kacheln, Karte, Raycast, Bewegung, Navigation, Generator,
                       Bedingungen (Tageszeit und Wetter)
  Tests/               NUnit-Tests, laufen im Editor und headless
  Runtime/             Brücke zu Unity (MonoBehaviours)
```

Die Simulation hat `noEngineReferences: true` in ihrer Assembly-Definition. Das
ist keine Kosmetik, sondern die Grenze, die den Port überhaupt praktikabel
macht: Simulationscode darf nichts über Darstellung wissen. Wenn dort eine
`MonoBehaviour`-Referenz hineinwandert, ist die Testbarkeit weg.

---

## Tests

**Im Editor:** *Window → General → Test Runner → EditMode → Run All*

**Ohne Editor**, direkt aus dem Repository-Wurzelverzeichnis:

```bash
dotnet test tools/csharp-verify
```

Das ist kein zweiter Testsatz – es sind exakt dieselben `.cs`-Dateien, die Unity
kompiliert, nur über ein separates Projekt eingebunden. Ein grüner Lauf sagt
also etwas über den Code aus, der auch ausgeliefert wird.

Aktuell **38 Tests**: Determinismus, Geometrie, Sichtlinien, Bewegung,
Navigation, Kartenerzeugung und Einsatzbedingungen.

Ein Test verdient besondere Erwähnung:
`Rng_MatchesTheReferenceImplementation` prüft den Zufallsstrom gegen fest
hinterlegte Werte aus dem TypeScript-Prototyp. Damit erzeugt derselbe Seed in
Unity **exakt dieselbe Karte** wie im Web-Prototyp – Fehlerberichte und
Balancing-Messungen bleiben zwischen beiden vergleichbar.

---

## Worauf beim Weiterbauen zu achten ist

**Die Kacheldaten bleiben die Wahrheit.** Der `TileMap` bestimmt Deckung,
Sichtlinie und Schallausbreitung. Es liegt nahe, in Unity stattdessen Collider
zu bauen und `Physics.Raycast` zu benutzen – damit verlierst du die Garantie,
dass die Wand, die du siehst, die Wand ist, die das Geschoss stoppt.

**Zufall läuft über `Rng`.** Nicht auf `UnityEngine.Random` umstellen. Sonst
sind Karten nicht mehr aus einem Seed reproduzierbar und Fehlerberichte
verlieren ihren Wert.

**Der Ereignisbus ist die Trennlinie.** Simulation veröffentlicht Nachrichten;
Darstellung, Ton und UI hören zu. Nie umgekehrt.

**Beleuchtung ist zweigeteilt.** `LampLight` hält den gebackenen Lampenanteil,
`Conditions.Apply` faltet den Himmel der jeweiligen Tageszeit darüber. Wer das
zusammenlegt, muss für jeden Wechsel der Tageszeit erneut pro beleuchteter
Kachel eine Sichtlinie prüfen – und verliert nebenbei, dass Straßenlaternen
nachts hell bleiben.

**A\* hat eine geschlossene Menge.** Das ist keine Optimierung. Ohne sie werden
veraltete Haufen-Duplikate erneut expandiert, die Suche verbrennt ihr
Knotenbudget und meldet gut erreichbare Ziele als unerreichbar. Genau dieser
Fehler steckte im Prototyp und hat die KI-Wegfindung still über die ganze Karte
verschlechtert. `NavGrid_FindsLongPathsAcrossVaryingTerrain` hält ihn fern.

Vollständige Portierungshinweise: [`../docs/UNITY_PORT.md`](../docs/UNITY_PORT.md)
