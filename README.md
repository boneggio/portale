# Portale Boneggio

Un solo link per tutte le app di Boneggio.

- `index.html`: la pagina pubblica da inviare (portale.boneggio.it)
- `admin.html`: la console (portale.boneggio.it/admin.html). Per ogni sezione: Attivo, Sold out, In arrivo, Nascosto e l'ordine con le frecce
- `functions/api/[[path]].js`: il server (Cloudflare Pages Functions), che salva le scelte nel database D1
- `loghi/`: le icone delle app

## Pubblicazione (una volta sola)

1. **GitHub**: crea il repository `boneggio/portale` e carica tutti i file di questa cartella.
2. **Cloudflare → Workers & Pages → Crea → Pages → Collega a Git** e scegli `boneggio/portale`.
   Framework: *Nessuno*. Comando di build: vuoto. Cartella di output: `/`.
3. **Cloudflare → D1**: crea il database `portale`. Le tabelle si creano da sole.
4. Nel progetto Pages, **Impostazioni → Associazioni (Bindings) → Aggiungi → Database D1**:
   nome variabile `DB`, database `portale`.
5. Nel progetto Pages, **Impostazioni → Variabili e segreti**, di tipo *Segreto*:
   - `PASSWORD_ADMIN`: la password della console
6. **Deployments → Riprova il deployment**, così prende database e segreti.
7. **Domini personalizzati → portale.boneggio.it**. Su Aruba aggiungi un record CNAME `portale` → `portale.pages.dev`.
8. Il codice a 6 cifre si attiva dalla console, nella sezione Sicurezza.
9. Apri `https://portale.boneggio.it/admin.html`, entra e, in "Modifica testo e link", incolla per OliAmo e Castagnacopo il link con `?c=…`.

## Aggiungere una nuova app

Aggiungi un blocco nell'elenco `SEZIONI` in `functions/api/[[path]].js` e il suo logo in `loghi/`. Il resto (stato, ordine, testi, link) si gestisce dalla console.
