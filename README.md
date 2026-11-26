# Byaku map

A static apartment map. It runs entirely in the browser and is published with GitHub Pages.

- Enter an address yourself. The app never opens listing websites.
- Shows nearby subway stations and recent NYPD complaints for each apartment.
- Saved apartments stay in your browser only.

## One-time setup

1. Open **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Set the branch to **main** and the folder to **/ (root)**, then click **Save**.
4. Wait a minute or two. The site address appears at the top of the Pages screen.

## Importing Google Maps lists

1. Go to takeout.google.com, choose only **Maps (your places)**, and export.
2. Unzip the download. Upload the list files (CSV per list, or the GeoJSON file) with **Import Takeout file(s)** in the side panel.
3. Each file becomes one list you can switch on or off. Places from short links (maps.app.goo.gl) can't be placed and are skipped.
