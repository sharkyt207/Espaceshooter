# Portierung nach Unity

Der Prototyp ist so gebaut, dass der Simulationsteil praktisch unverändert
übernommen werden kann. Dieses Dokument sagt, was übertragen wird, was ersetzt
wird und wo die Fallstricke liegen.

---

## Übersicht

| Bereich | Vorgehen |
| --- | --- |
| `core/` | **Übernehmen.** Mathematik, RNG, Pools, Raumgitter, Ereignisbus sind reines C#-Äquivalent. `Loop` entfällt (Unity liefert `FixedUpdate`). |
| `data/` | **Übernehmen als ScriptableObjects.** Jedes `ItemDef` wird eine Asset-Datei. |
| `world/` | **Übernehmen.** Kachelkarte, Generator, Navigation, Physikhelfer sind engine-unabhängig. |
| `combat/`, `weapons/`, `health/`, `inventory/`, `loot/`, `ai/`, `raid/`, `meta/`, `save/` | **Übernehmen.** Kein Unity-spezifischer Code nötig. |
| `render/` | **Ersetzen.** Vollständig durch URP und echte Geometrie. |
| `ui/` | **Ersetzen.** Durch UI Toolkit. Bildschirmlogik und Datenfluss bleiben. |
| `audio/` | **Ersetzen.** Durch AudioSource/AudioMixer; Parameterabbildung beibehalten. |
| `input/` | **Ersetzen.** Durch das Input System; `InputState` als Schnittstelle beibehalten. |

---

## Reihenfolge

**1. Datenschicht zuerst.**
`ItemDef` und die zugehörigen Statistik-Strukturen werden ScriptableObjects. Ein
kleines Editor-Skript, das die TypeScript-Definitionen einliest und Assets
erzeugt, spart hier viel Handarbeit und hält Balancing-Werte identisch.

**2. Simulation portieren, mit Tests.**
`tests/simulation.test.ts` beschreibt das erwartete Verhalten von Ballistik,
Gesundheit, Inventar, Navigation und Wirtschaft. Diese Tests zuerst nach NUnit
übersetzen, dann die Systeme daneben portieren – so ist jederzeit belegbar, dass
die Portierung dasselbe Spiel ist.

**3. Welt und Navigation.**
Der Kartengenerator läuft unverändert und liefert weiterhin ein `GeneratedMap`.
Statt Kacheln zu zeichnen, instanziiert eine Aufbauschicht Prefabs anhand der
Kacheltypen. Wichtig: **die Kacheldaten bleiben die Wahrheit** für Ballistik,
Deckung und Schall. Wer sie durch Unity-Collider ersetzt, verliert die Garantie,
dass Sicht, Schuss und Ton übereinstimmen.

Für Navigation gibt es zwei Wege:
- Die eigene `NavGrid` behalten – deterministisch, budgetierbar, passt exakt zur
  Kachelwelt. Empfohlen.
- Auf Unity NavMesh wechseln – bequemer, aber Budgetierung und Determinismus
  müssen neu gelöst werden.

**4. Darstellung neu bauen.**
Hier entsteht der eigentliche Mehrwert der Portierung. Der Raycaster entfällt
komplett. Was bleibt: der Kameravertrag (Position, Gierwinkel, Neigung,
Augenhöhe, Sichtfeld) und die Tatsache, dass Rückstoß in die **Zielrichtung**
einfließt und nicht nur ein kosmetischer Kameraschlag ist.

**5. Oberfläche neu bauen.**
Der Bildschirmstapel (`ScreenManager`) und die Datenaufbereitung der einzelnen
Bildschirme lassen sich fast eins zu eins übersetzen. Das Rasterinventar wird
ein `VisualElement`-Grid.

---

## Was sich ändern muss

### Feste Schrittweite

`core/Loop.ts` entfällt. In Unity:

```csharp
Time.fixedDeltaTime = 1f / 60f;   // Simulation
Application.targetFrameRate = 60; // Darstellung
```

Simulation gehört in `FixedUpdate`, Eingabeabfrage und Kameraglättung in
`Update`. Die Reihenfolge „Eingabe → Spieler → Welt → Oberfläche“ muss erhalten
bleiben.

### Aufzählungen

Der Prototyp nutzt bewusst `const`-Objekte statt TypeScript-`enum`s
(damit Node den Code ohne Transformation ausführen kann). In C# werden daraus
ganz normale `enum`s – die Zahlenwerte sind bereits stabil vergeben.

### Konstruktor-Parametereigenschaften

`constructor(private readonly bus: GameBus)` wird zu einem gewöhnlichen Feld mit
Zuweisung im Konstruktor. Rein mechanisch.

### Typisierte Arrays

`Float32Array` → `float[]`, `Int32Array` → `int[]`, `Uint8Array` → `byte[]`.
Für die heißen Pfade (Lightmap, Kosten, Tiefenpuffer) lohnt sich
`NativeArray<T>` mit dem Job System.

### Speichern

`localStorage` → `Application.persistentDataPath` mit JSON. Die
Versionierung und die Migrationskette unbedingt beibehalten; ebenso das
Verwerfen unbekannter Gegenstands-IDs beim Laden.

---

## Fallstricke

**Der Ereignisbus ist die Trennlinie.**
Die strikte Regel „Simulation importiert nie Darstellung“ ist der Grund, warum
diese Portierung überhaupt praktikabel ist. Wenn beim Portieren
`MonoBehaviour`-Referenzen in Simulationsklassen wandern, geht diese Eigenschaft
verloren und die Testbarkeit gleich mit.

**Determinismus.**
Alle Zufallsentscheidungen laufen über gesetzte Ströme. In Unity nicht auf
`UnityEngine.Random` umstellen – die eigene `Rng` mitnehmen. Sonst sind Karten
nicht mehr aus einem Seed reproduzierbar und Fehlerberichte verlieren ihren
Wert.

**Ballistik als echte Projektile.**
Es liegt nahe, in Unity auf Raycasts umzustellen. Das kostet Flugzeit,
Vorhalten, Energieverlust beim Durchschlag und die Sichtbarkeit der Leuchtspur –
also genau die Eigenschaften, die das Schießgefühl tragen. Besser: die eigene
Integration behalten und nur die Trefferabfrage gegen Unity-Collider tauschen,
falls Geometrie feiner wird als das Kachelraster.

**KI-Budgetierung.**
Der `AIDirector` begrenzt Wegsuchen pro Bild und senkt die Tickrate entfernter,
ahnungsloser Gegner. Auf einer stärkeren Engine ist die Versuchung groß, das
wegzulassen – auf Zielhardware ist es genau der Grund für stabile 60 FPS.

**Trefferzonen.**
Die Zonenauflösung arbeitet mit Bruchteilen der Körperhöhe und einem seitlichen
Versatz. Mit echten Skeletten kann stattdessen der getroffene Collider gelesen
werden – die Zuordnung Collider → `BodyPart` sollte dann aber dieselbe
Verteilung ergeben, sonst verschiebt sich die gesamte Kampfbalance.

---

## Was nicht portiert werden muss

- `render/Raycaster.ts`, `render/SpriteRenderer.ts`, `render/Textures.ts`,
  `render/Sprites.ts` – ersatzlos.
- `render/RaidRenderer.ts` – nur der Kamera- und Rückstoßvertrag ist relevant.
- `core/Loop.ts` – bis auf `PerfGovernor`, dessen Idee (adaptive
  Auflösungsskalierung) in URP über die Render Scale weiterlebt.
- `tests/ts-loader.mjs`, `tests/register.mjs` – reine Werkzeuge der
  Node-Testausführung.

---

## Empfohlene Zielstruktur

```
Assets/
  Scripts/
    Core/          Math, Rng, EventBus, Pool, SpatialHash
    Data/          ScriptableObjects + Registry
    World/         TileMap, MapGenerator, NavGrid, CoverMap, Physics
    Combat/        Ballistics, Combatant, HitZones
    Weapons/       WeaponRuntime, WeaponController
    Health/        HealthSystem
    Inventory/     ItemStack, GridContainer, Inventory
    Loot/          LootTables, LootSystem
    AI/            Profiles, Perception, Enemy, Director
    Raid/          RaidSession, Extraction, DynamicEvents
    Meta/          Profile, Progression, Traders, Quests, Hideout, Crafting
    Save/          SaveSystem
    Presentation/  Kamera, Waffenmodell, Effekte, Audio  ← neu
    UI/            UI-Toolkit-Bildschirme                 ← neu
  Tests/
    EditMode/      Portierte Simulationstests
```
