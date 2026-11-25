# Form-Markexhaust

A party and product order form with an admin-only Excel export.

## Run locally on Windows

1. Put the private `parties.json` and `products.json` master-data files in this folder.
2. Start the server from PowerShell:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\server.ps1
   ```

3. Enter an admin password with at least 12 characters when prompted.
4. Open the party form at `http://127.0.0.1:8787/` or the admin panel at `http://127.0.0.1:8787/admin`.

The party JSON must contain `party code`, `party name`, `party add1`, `party add 2`, `city`, `state`, `pin`, `state 1`, `status`, and `md/td` fields. The product JSON must contain `part number`, `product code`, `product name`, `mrp`, `md price`, and `td price` fields.

Submissions are saved locally to `submissions.json`. These data files and Excel workbooks are excluded from Git by `.gitignore`; keep private business data in approved private storage. The admin Excel download uses a browser-hosted XLSX library and requires an internet connection.

This PowerShell server listens on `127.0.0.1` for local use. GitHub Pages cannot run the server or store submissions; public hosting requires a separate server deployment and private data storage.
