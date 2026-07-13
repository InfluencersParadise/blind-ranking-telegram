# Blind Ranking – Telegram Mini App

Fertiges MVP ohne Datenbank. Der Bot veröffentlicht in einer Telegram-Gruppe einen Startbutton. Jeder Spieler rankt fünf Bilder; anschließend sendet die Mini App das Ergebnis über den Bot zurück in die Gruppe.

## Was du noch selbst tun musst

Externe Konten und geheime Zugangsdaten dürfen nicht von jemand anderem erstellt oder übernommen werden. Du brauchst daher nur diese einmaligen Klicks:

1. Kostenloses GitHub-Konto (falls noch nicht vorhanden)
2. Kostenloses Vercel-Konto
3. Telegram-Bot über @BotFather erstellen
4. Drei Variablen in Vercel eintragen
5. Zwei Telegram-URLs einmal im Browser aufrufen

## Schritt 1 – Telegram-Bot anlegen

1. Öffne Telegram und suche `@BotFather`.
2. Sende `/newbot`.
3. Vergib einen Namen, z. B. `Blind Ranking`.
4. Vergib einen eindeutigen Nutzernamen, der auf `bot` endet, z. B. `meine_blindranking_bot`.
5. Kopiere den Bot-Token. Er sieht ungefähr so aus: `123456789:AA...`.
6. Sende an BotFather `/setjoingroups`, wähle deinen Bot und aktiviere Gruppen.

Den Token niemals öffentlich posten.

## Schritt 2 – Projekt auf GitHub hochladen

Einfachste Variante ohne Terminal:

1. Entpacke die ZIP-Datei.
2. Öffne github.com und erstelle ein neues Repository, z. B. `blind-ranking-telegram`.
3. Wähle im Repository `Add file` → `Upload files`.
4. Ziehe den gesamten Inhalt des entpackten Ordners hinein.
5. Klicke `Commit changes`.

Wichtig: Lade nicht versehentlich eine echte `.env`-Datei oder deinen Bot-Token hoch.

## Schritt 3 – Kostenlos bei Vercel bereitstellen

1. Öffne vercel.com und melde dich mit GitHub an.
2. Klicke `Add New` → `Project`.
3. Importiere dein GitHub-Repository.
4. Framework sollte automatisch als Next.js erkannt werden.
5. Klicke zunächst `Deploy`.
6. Nach dem Deployment erhältst du eine Adresse wie `https://blind-ranking-telegram.vercel.app`.

## Schritt 4 – Geheime Variablen eintragen

In Vercel: Projekt → `Settings` → `Environment Variables`.

Lege diese drei Variablen für Production, Preview und Development an:

- `TELEGRAM_BOT_TOKEN` = dein BotFather-Token
- `NEXT_PUBLIC_APP_URL` = deine vollständige Vercel-Adresse ohne abschließenden Slash
- `WEBHOOK_SECRET` = eine lange zufällige Zeichenfolge, z. B. mindestens 32 Zeichen

Anschließend unter `Deployments` beim letzten Deployment die drei Punkte öffnen und `Redeploy` wählen.

## Schritt 5 – Mini-App-Domain bei BotFather setzen

1. Öffne `@BotFather`.
2. Sende `/setdomain`.
3. Wähle deinen Bot.
4. Sende nur die Domain deiner Vercel-App, z. B. `blind-ranking-telegram.vercel.app`.

## Schritt 6 – Telegram-Webhook aktivieren

Ersetze in der folgenden URL `BOT_TOKEN`, `APP_URL` und `WEBHOOK_SECRET` durch deine Werte. Öffne die fertige URL einmal im Browser:

```text
https://api.telegram.org/botBOT_TOKEN/setWebhook?url=APP_URL/api/telegram/webhook&secret_token=WEBHOOK_SECRET
```

Beispielstruktur:

```text
https://api.telegram.org/bot123456:ABC/setWebhook?url=https://blind-ranking-telegram.vercel.app/api/telegram/webhook&secret_token=mein-langes-geheimnis
```

Telegram sollte JSON mit `"ok":true` anzeigen.

## Schritt 7 – Bot zur Gruppe hinzufügen

1. Füge den Bot deiner Telegram-Gruppe hinzu.
2. Sende in der Gruppe `/blindranking`.
3. Tippe auf `🎮 Spiel starten`.
4. Ordne alle fünf Bilder ein.
5. Tippe auf `In Telegram-Gruppe teilen`.

## Häufige Fehler

### Button öffnet nichts
- Prüfe `/setdomain` bei BotFather.
- Prüfe, ob `NEXT_PUBLIC_APP_URL` exakt mit `https://` eingetragen ist.
- Redeploy nach Änderungen an Variablen.

### Bot reagiert nicht
- Rufe die `setWebhook`-URL erneut auf.
- Prüfe Schreibfehler in `WEBHOOK_SECRET`.
- Prüfe, ob der Bot in der Gruppe ist.

### Ergebnis kann nicht gesendet werden
- Prüfe, ob der Bot weiterhin Mitglied der Gruppe ist und Nachrichten senden darf.
- Öffne das Spiel über den Button des Bots, nicht direkt über die Vercel-Adresse.

## Bilder und Rechte

Die Demo verwendet externe Unsplash-Bild-URLs. Für eine öffentliche oder kommerzielle App solltest du eigene oder eindeutig lizenzierte Bilder verwenden und die Lizenzbedingungen prüfen.

## Später mögliche Erweiterungen

- Kategorien auswählen
- eigene Bilder hochladen
- Datenbank und Bestenliste
- Timer
- echte Spielräume und gemeinsame Runden
- Admin-Oberfläche
