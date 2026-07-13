# Blind Ranking Telegram V3.1 – öffentliche Player, Creator-Kontingente

## Rollen

- **Owner:** über `ADMIN_TELEGRAM_USER_ID`, unbegrenzt, verwaltet Creator und Tokens.
- **Creator:** direkte Freigabe per Telegram-ID oder einmaliger Creator-Token. Jeder Creator besitzt ein Kontingent von 1, 3, 5, 10 Kategorien oder unbegrenzt.
- **Player:** automatisch jeder Telegram-Nutzer. Keine Freigabe und kein Token nötig. Player dürfen abstimmen und Statistiken ansehen, aber keine Kategorien erstellen und keine Spiele in Gruppen starten.

Das Kategorienkontingent zählt erstellte Kategorien dauerhaft. Das Löschen einer Kategorie gibt keinen Platz zurück. Der Owner kann das Kontingent später ändern.

## Owner-Menü

Im privaten Chat:

```text
/rollen
```

Funktionen:

- Creator-Token mit Kontingent erstellen
- Creator per Telegram-ID und Kontingent genehmigen
- Creator und Verbrauch anzeigen
- offene Tokens anzeigen
- Kontingent ändern
- Creator sperren

## Creator

Token einlösen:

```text
/aktivieren BR-XXXX-XXXX-XXXX
```

Eigenes Kontingent anzeigen:

```text
/meinkonto
```

## Update installieren

1. `supabase.sql` vollständig im Supabase SQL Editor ausführen.
2. Danach den gesamten Projektinhalt in das bestehende GitHub-Repository hochladen und Dateien ersetzen.
3. Änderungen committen.
4. Vercel neu deployen lassen; Build-Cache beim manuellen Redeploy deaktivieren.
5. Webhook und vorhandene Environment Variables bleiben unverändert.

## Vorhandene Creator

Bereits gespeicherte Creator werden durch das SQL-Update auf **unbegrenzt** gesetzt. Ihre bisher erstellten Kategorien werden als Verbrauch erfasst.
