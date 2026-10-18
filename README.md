# BlueBio – Maharashtra coastal marine platform (real data)
Stack: PostGIS (db) · Python FastAPI + scikit-learn (ml) · Node/Express + Leaflet/Chart.js (api + web).
Data: Copernicus Marine (temperature, salinity, chlorophyll, oxygen), OBIS + GBIF (ray-finned fish occurrence records).

1. Create a free Copernicus Marine account (https://marine.copernicus.eu), then `cp .env.example .env` and fill in the credentials.
2. `docker compose up --build`
3. Load real data: `curl -X POST http://localhost:8000/run`  (progress: `curl http://localhost:8000/status`, logs: `docker compose logs -f ml`)
4. Open http://localhost:3000. Re-run step 3 any time to refresh.
Fish "abundance" = number of occurrence records (a sampling-effort-dependent proxy), not landed catch tonnage.
