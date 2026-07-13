# Blind Ranking Telegram – Version 2

Diese Version verwaltet Kategorien und Bilder vollständig im privaten Telegram-Chat mit dem Bot. Die Mini App läuft dauerhaft im Dark Mode.

## Wichtige Verbesserung

In der früheren Version wurde eine normale Namensnachricht versehentlich wie ein Befehl behandelt. Dadurch blieb der Bot nach der Frage „Wie heißt dieses Bild?“ stehen. Version 2 behebt diesen Fehler.

## Funktionen

- Kategorien über Telegram erstellen
- Bilder mit oder ohne Bildunterschrift hochladen
- Kategorien aktivieren, umbenennen und löschen
- Bilder umbenennen, ersetzen und löschen
- 2 bis 10 Bilder pro Kategorie
- Auswahl einer bestimmten Kategorie in der Gruppe
- Dark-Mode-Mini-App
- Ergebnis wird wieder in die ursprüngliche Gruppe gesendet

## Upgrade deines vorhandenen Projekts

1. ZIP entpacken.
2. Den gesamten Inhalt in dein bestehendes GitHub-Repository hochladen und vorhandene Dateien ersetzen.
3. `Commit changes` anklicken.
4. Vercel erstellt automatisch ein neues Deployment.
5. Falls nicht: Vercel → Deployments → Redeploy. Build Cache deaktiviert lassen.
6. Warten, bis der Status `Ready` lautet.

Deine bestehenden Vercel-Variablen bleiben unverändert:

- `TELEGRAM_BOT_TOKEN`
- `NEXT_PUBLIC_APP_URL`
- `WEBHOOK_SECRET`
- `ADMIN_TELEGRAM_USER_ID`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Supabase aktualisieren

Öffne Supabase → SQL Editor. Kopiere den vollständigen Inhalt von `supabase.sql` hinein und klicke auf `Run`.

Das Skript ist wiederholbar und ergänzt nur die neuen Spalten. Vorhandene Kategorien und Bilder bleiben erhalten.

## Bedienung im privaten Bot-Chat

### Kategorie erstellen

```text
/neuekategorie Influencer
```

Danach ein Bild senden. Es gibt zwei Varianten:

1. Bild ohne Bildunterschrift senden → Bot fragt nach dem Namen.
2. Bild mit Bildunterschrift senden → die Bildunterschrift wird direkt als Name gespeichert.

Nach mindestens zwei Bildern:

```text
/fertig
```

### Kategorien verwalten

```text
/kategorien
```

Danach erscheinen Schaltflächen für:

- Aktivieren
- Bild hinzufügen
- Bilder verwalten
- Kategorie umbenennen
- Kategorie löschen

Unter „Bilder verwalten“ kann jeder Eintrag umbenannt, ersetzt oder gelöscht werden.

### Aktuelle Eingabe abbrechen

```text
/abbrechen
```

## Spiel in der Gruppe

Aktive Kategorie starten:

```text
/blindranking
```

Bestimmte Kategorie starten:

```text
/blindranking Influencer
```

## Test nach dem Deployment

1. Im privaten Chat `/neuekategorie Test` senden.
2. Ein Bild senden.
3. Einen Namen senden.
4. Der Bot muss jetzt mit `hinzugefügt` antworten.
5. Zweites Bild hinzufügen.
6. `/fertig` senden.
7. In der Gruppe `/blindranking` senden.

## Sicherheit

Bot-Token, Webhook-Secret und Supabase-Secret-Key niemals in GitHub, Screenshots oder Chats veröffentlichen. Bereits veröffentlichte Bot-Tokens müssen bei BotFather mit `/revoke` ersetzt werden.

## Änderung: vollständige Bilder und Ranking-Album

- Die Mini App zeigt hochformatige und querformatige Bilder vollständig mit `object-fit: contain` an.
- Beim Teilen sendet der Bot alle Ranking-Bilder als Telegram-Album in der gewählten Reihenfolge.

## Befehlsübersicht

Mit `/commands` zeigt der Bot alle verfügbaren Befehle und ein Button-Menü an.

- `/blindranking` – aktive Kategorie starten
- `/blindranking Kategorie` – bestimmte Kategorie starten
- `/neuekategorie Name` – Kategorie erstellen
- `/kategorien` – Kategorien verwalten
- `/bearbeiten Kategorie` – Kategorie direkt öffnen
- `/loeschen Kategorie` – Kategorie mit Sicherheitsabfrage löschen
- `/fertig` – Bearbeitung abschließen und aktivieren
- `/abbrechen` – aktuelle Eingabe abbrechen
- `/commands` – Hilfe und Schnellzugriff anzeigen

## Update 2.2 – Bilder/Text, bis zu 30 Einträge und Stimmenverteilung

Vor dem Deployment den aktualisierten Inhalt von `supabase.sql` einmal im Supabase SQL Editor ausführen. Die Befehle sind migrationssicher (`if not exists`).

In `/kategorien` → Kategorie auswählen kann eingestellt werden:

- **Ergebnis mit Bildern:** zuerst Bilder/Alben, danach eine separate Textnachricht.
- **Ergebnis ohne Bilder:** nur die Textnachricht.

Telegram erlaubt pro Album höchstens 10 Bilder. Kategorien dürfen nun bis zu 30 Einträge enthalten; größere Rankings werden automatisch in mehrere Alben aufgeteilt.

Pro Nutzer, Gruppe und Kategorie wird eine Stimme gespeichert. Eine erneute Abgabe ersetzt die vorherige Stimme. Nach dem Absenden zeigt die Textnachricht zusätzlich die aggregierte Platzverteilung der anderen Nutzer in derselben Gruppe.
