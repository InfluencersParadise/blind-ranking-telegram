# Blind Ranking – Telegram-Upload + Dark Mode

Diese Version erlaubt dir, Kategorien, Bilder und Namen vollständig im privaten Chat mit deinem Telegram-Bot zu verwalten. GitHub musst du danach für neue Spielinhalte nicht mehr öffnen.

## So funktioniert die Verwaltung

Im privaten Chat mit dem Bot:

```text
/neuekategorie Fußballer
```

Danach:

1. Bild an den Bot senden.
2. Bot fragt nach dem Namen.
3. Namen senden, z. B. `Lionel Messi`.
4. Weitere Bilder senden.
5. Nach 2 bis 10 Bildern `/fertig` senden.

Schneller geht es, wenn du den Namen direkt als **Bildunterschrift** mitsendest. Dann wird das Bild sofort gespeichert.

In der Gruppe:

```text
/blindranking
```

Für eine bestimmte vorhandene Kategorie:

```text
/blindranking Fußballer
```

## Admin-Befehle

```text
/admin
/neuekategorie Kategoriename
/fertig
/kategorien
/aktiv Kategoriename
/löschen Kategoriename
```

Nur die Telegram-Nutzer-ID aus `ADMIN_TELEGRAM_USER_ID` darf Kategorien verwalten.

---

# Einmalige Einrichtung

## 1. Kostenloses Supabase-Projekt anlegen

1. Öffne `supabase.com` und melde dich an.
2. Klicke auf **New project**.
3. Vergib einen Projektnamen und ein Datenbankpasswort.
4. Warte, bis das Projekt bereit ist.

## 2. Datenbank und Bildspeicher einrichten

1. Öffne in Supabase links **SQL Editor**.
2. Klicke auf **New query**.
3. Öffne aus diesem Projekt die Datei `supabase.sql`.
4. Kopiere ihren gesamten Inhalt in den SQL Editor.
5. Klicke auf **Run**.

Das Skript erstellt:

- Kategorien
- Bildeinträge
- Admin-Zwischenstände
- aktive Kategorie
- öffentlichen Storage-Bucket `blind-ranking-images`

## 3. Supabase-Schlüssel kopieren

In Supabase:

1. **Project Settings** öffnen.
2. **API** bzw. **Data API** öffnen.
3. Kopiere die **Project URL**.
4. Kopiere den **service_role key**.

Achtung: Der `service_role`-Schlüssel ist geheim. Nicht in GitHub, Telegram oder Screenshots veröffentlichen.

## 4. Eigene Telegram-Nutzer-ID herausfinden

Schreibe in Telegram beispielsweise dem Bot `@userinfobot` oder einem vergleichbaren ID-Bot. Kopiere deine numerische Telegram User ID.

Diese ID ist nicht dein Nutzername und nicht die Gruppen-ID.

## 5. Neue Variablen in Vercel ergänzen

In Vercel unter **Environment Variables** zusätzlich zu deinen bisherigen drei Variablen anlegen:

```text
ADMIN_TELEGRAM_USER_ID = deine numerische Telegram-Nutzer-ID
SUPABASE_URL = deine Supabase Project URL
SUPABASE_SERVICE_ROLE_KEY = dein geheimer service_role key
```

Damit sind insgesamt diese sechs Variablen vorhanden:

```text
TELEGRAM_BOT_TOKEN
NEXT_PUBLIC_APP_URL
WEBHOOK_SECRET
ADMIN_TELEGRAM_USER_ID
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Für alle Variablen mindestens **Production** aktivieren. Danach ein neues **Redeploy** ohne alten Build Cache starten.

## 6. Projekt aktualisieren

1. Lade alle Dateien dieses Projekts in dein bestehendes GitHub-Repository hoch.
2. Vorhandene Dateien ersetzen.
3. Änderungen committen.
4. Vercel startet automatisch ein Deployment.
5. Warten, bis der Status **Ready** ist.

Der bestehende Telegram-Webhook und die BotFather-Domain müssen nicht neu gesetzt werden, solange Domain und Bot gleich bleiben.

---

# Erster Test

1. Öffne den privaten Chat mit deinem Bot.
2. Sende `/admin`.
3. Sende `/neuekategorie Test`.
4. Sende mindestens zwei Bilder und jeweils den Namen.
5. Sende `/fertig`.
6. Öffne deine Telegram-Gruppe.
7. Sende `/blindranking`.

## Wichtige Hinweise

- Erlaubt sind 2 bis 10 Bilder pro Kategorie.
- Die Mini App zeigt die Bilder in zufälliger Reihenfolge.
- Die Website bleibt dauerhaft im Dark Mode.
- Bilder werden aus Telegram heruntergeladen und anschließend in Supabase Storage gespeichert.
- Das Frontend erhält niemals deinen Telegram-Bot-Token oder den Supabase-Service-Key.
- Bei `/löschen Kategoriename` werden die Datenbankeinträge gelöscht. Die zugehörigen Storage-Dateien werden in dieser MVP-Version noch nicht automatisch entfernt.
