# Als App aufs Handy

Ziel: ein Symbol auf dem Home-Bildschirm, das das Spiel im Vollbild startet —
auch ohne Netz.

---

## Warum nicht einfach die Vorschau-Seite speichern

Die Artefakt-Vorschau läuft in einem Rahmen auf einer fremden Domain. Legt man
die auf den Home-Bildschirm, bekommt man ein Lesezeichen auf diese Domain: mit
Anmeldung, mit Browserleisten, ohne eigenes Symbol und ohne Offline-Fähigkeit.
Ein Service Worker darf dort ohnehin nicht für das Spiel laufen.

Damit daraus eine App wird, braucht das Spiel **eine eigene Adresse**. Das ist
der einzige Schritt, den ich nicht von hier aus erledigen kann — er verlangt
zwei Einstellungen in Deinem GitHub-Konto.

---

## Schritt 1 — Veröffentlichung einschalten (einmalig)

Alles dafür Nötige liegt schon im Projekt (`.github/workflows/pages.yml`). Es
fehlt nur die Freigabe:

**Zuerst der Merge — ohne ihn passiert gar nichts.** Der Veröffentlichungs-
Ablauf liegt auf dem Arbeitsbranch und löst nur bei einem Push auf `main` aus.
Solange `main` ihn nicht enthält, gibt es keinen Workflow, keinen Lauf und
folglich auch keine Seite. Das ist unabhängig davon, was unter *Pages*
eingestellt ist.

1. Auf **github.com/sharkyt207/Espaceshooter** gehen (Safari genügt, geht am
   iPhone).
2. Den Branch `claude/mobile-extraction-shooter-15mgjf` nach `main`
   **zusammenführen**.
3. **Settings** → in der linken Liste **Pages**.
4. Unter *Build and deployment* bei **Source** → **GitHub Actions** wählen.

Danach baut GitHub das Spiel bei jedem Push selbst und legt es ab unter:

```
https://sharkyt207.github.io/Espaceshooter/
```

Der Ablauf prüft vor jeder Veröffentlichung Typen, Tests und Build — eine
kaputte Fassung kann nicht auf ein Gerät gelangen, auf dem sie schon installiert
ist.

> Wenn beim ersten Mal nichts erscheint: unter **Actions** den Lauf „Pages"
> ansehen. Beim allerersten Mal muss er eventuell manuell über *Run workflow*
> gestartet werden.

---

## Schritt 2 — Aufs Handy holen

### iPhone (Safari — **nicht** Chrome)

1. `https://sharkyt207.github.io/Espaceshooter/` in **Safari** öffnen.
2. Unten auf **Teilen** (Quadrat mit Pfeil nach oben).
3. Nach unten wischen → **Zum Home-Bildschirm**.
4. **Hinzufügen**.

Wichtig: Auf iOS kann **nur Safari** das. Chrome und Firefox zeigen den Eintrag
nicht an.

### Android (Chrome)

1. Adresse in Chrome öffnen.
2. Menü (drei Punkte) → **App installieren** bzw. **Zum Startbildschirm
   hinzufügen**.

---

## Was Du danach hast

| | |
|---|---|
| Eigenes Symbol | ohne Browserleisten |
| Vollbild, Querformat | auf dem iPhone ist der Home-Bildschirm der **einzige** Weg dorthin — Safari hat dort keine Vollbild-Funktion, und seine Leisten kosten rund 15 % einer ohnehin niedrigen Landschaftsansicht |
| Läuft ohne Netz | Flugmodus, U-Bahn, Funkloch — alles egal |
| Spielstand bleibt | liegt lokal auf dem Gerät |
| Aktualisiert sich | beim nächsten Start mit Netz, im Hintergrund |

Geprüft, nicht behauptet:

- `tests/offline.mjs` lädt das Spiel, **kappt die Netzverbindung**, lädt neu und
  verlangt einen laufenden Einsatz mit Gegnern. Fünf Läufe grün mit dem Service
  Worker, fünf Läufe rot ohne ihn.
- `tests/pwa.mjs` prüft dasselbe Bündel unter **genau dem Unterordner-Layout,
  das GitHub Pages benutzt** (`/Espaceshooter/`): Manifest erreichbar, alle vier
  Symbole liefern 200, `start_url` und `scope` zeigen in den Unterordner statt
  auf die Domain-Wurzel, Vollbild und Querformat gesetzt, Service Worker
  kontrolliert die Seite. Das ist der Test, der „Symbol wird zur App" von
  „Symbol wird zum grauen Lesezeichen" trennt.

---

## Wenn etwas nicht stimmt

**Weiße Seite nach dem Update.** Einmal aus dem App-Umschalter schließen und neu
öffnen. Der neue Stand wird beim Start geholt und beim übernächsten Start aktiv
— das ist die Regel, die verhindert, dass ein Update mitten im Einsatz
dazwischenfunkt.

**„Zum Home-Bildschirm" fehlt.** Du bist nicht in Safari. Adresse kopieren, in
Safari einfügen.

**Offline kommt eine Fehlerseite.** Einmal *mit* Netz starten und ein paar
Sekunden warten — beim ersten Besuch legt das Spiel seinen Vorrat an. Danach ist
Netz nicht mehr nötig.

**Hochkant erscheint „Bitte Gerät drehen".** So gedacht. Das Spiel läuft im
Querformat; die Ausrichtungssperre des iPhones ggf. lösen.
