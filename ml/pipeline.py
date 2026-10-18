"""BlueBio pipeline: ingest (Copernicus Marine, OBIS, GBIF) -> PostGIS -> ML analysis."""
import os, datetime as dt, numpy as np, pandas as pd, psycopg2, requests
from psycopg2.extras import execute_values
from sklearn.ensemble import IsolationForest
DB = os.getenv("DATABASE_URL")
X0, Y0, X1, Y1 = 72.2, 15.7, 73.3, 20.2   # Maharashtra offshore bounding box
WKT = f"POLYGON(({X0} {Y0},{X1} {Y0},{X1} {Y1},{X0} {Y1},{X0} {Y0}))"

PHY_T = "cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m"
PHY_S = "cmems_mod_glo_phy-so_anfc_0.083deg_P1D-m"
BGC = "cmems_mod_glo_bgc-bio_anfc_0.25deg_P1D-m"
PFT = "cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m"

VARS = {
    PHY_T: {"thetao": "sst"},
    PHY_S: {"so": "salinity"},
    BGC: {"o2": "oxygen"},
    PFT: {"chl": "chlorophyll"}
}

def ingest_ocean(start, end):
    import copernicusmarine as cm
    with psycopg2.connect(DB) as c, c.cursor() as cur:
        cur.execute("select id,ST_XMin(geom),ST_YMin(geom),ST_XMax(geom),ST_YMax(geom) from regions")
        regs, rows = cur.fetchall(), []
        for ds, vm in VARS.items():
            d = cm.open_dataset(dataset_id=ds, variables=list(vm), minimum_longitude=X0, maximum_longitude=X1,
                minimum_latitude=Y0, maximum_latitude=Y1, start_datetime=start, end_datetime=end,
                minimum_depth=0, maximum_depth=2)
            if "depth" in d.dims: d = d.isel(depth=0)
            for rid, a, b, e, f in regs:
                s = d.sel(longitude=slice(a, e), latitude=slice(b, f))
                for v, p in vm.items():
                    m = s[v].mean(dim=["latitude", "longitude"]).resample(time="MS").mean().to_series().dropna()
                    k = 0.032 if v == "o2" else 1.0   # mmol/m3 -> mg/L
                    rows += [(rid, t.date(), p, float(x) * k) for t, x in m.items()]
        execute_values(cur, "insert into ocean_obs values %s on conflict (region_id,month,param) do update set value=excluded.value", rows)
    print("ocean rows:", len(rows))

def _day(s):
    s = str(s).split("/")[0]
    t = pd.to_datetime(s, errors="coerce") if len(s) >= 10 else pd.NaT
    return None if pd.isna(t) else t.date()

def _save(rows):
    if rows:
        with psycopg2.connect(DB) as c, c.cursor() as cur:
            execute_values(cur, "insert into fish_obs(source,source_id,species,obs_date,geom) values %s on conflict do nothing",
                rows, template="(%s,%s,%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326))")

def ingest_fish(since="2010-01-01"):
    after = None   # OBIS: ray-finned fishes (Actinopterygii, AphiaID 10194)
    for _ in range(100):
        p = {"geometry": WKT, "taxonid": 10194, "startdate": since, "size": 1000}
        if after: p["after"] = after
        res = requests.get("https://api.obis.org/v3/occurrence", params=p, timeout=120).json().get("results", [])
        if not res: break
        _save([("obis", str(o["id"]), o.get("scientificName"), _day(o.get("eventDate")), o["decimalLongitude"], o["decimalLatitude"])
               for o in res if o.get("scientificName") and o.get("decimalLatitude") is not None and _day(o.get("eventDate"))])
        after = res[-1]["id"]
    for off in range(0, 100000, 300):   # GBIF: class Actinopterygii (classKey 204)
        r = requests.get("https://api.gbif.org/v1/occurrence/search", timeout=120, params={"geometry": WKT, "classKey": 204,
            "hasCoordinate": "true", "year": f"{since[:4]},{dt.date.today().year}", "limit": 300, "offset": off}).json()
        _save([("gbif", str(o["key"]), o.get("species"), _day(o.get("eventDate")), o["decimalLongitude"], o["decimalLatitude"])
               for o in r.get("results", []) if o.get("species") and _day(o.get("eventDate"))])
        if r.get("endOfRecords", True): break
    with psycopg2.connect(DB) as c, c.cursor() as cur:   # keep only records inside the offshore zones
        cur.execute("delete from fish_obs f where not exists (select 1 from regions r where ST_Within(f.geom,r.geom))")
        cur.execute("select count(*) from fish_obs"); print("fish records:", cur.fetchone()[0])

def analyze():
    with psycopg2.connect(DB) as c, c.cursor() as cur:
        df = pd.read_sql("select region_id,month,param,value from ocean_obs", c)
        cur.execute("truncate anomalies, insights")
        for rid, g in df.groupby("region_id"):
            w = g.pivot(index="month", columns="param", values="value").sort_index().interpolate().dropna()
            if len(w) < 12: continue
            mon = pd.to_datetime(w.index).month
            res = w - w.groupby(mon).transform("mean")                 # remove seasonal cycle
            z = (res / res.std(ddof=0).replace(0, np.nan)).fillna(0)
            flag = IsolationForest(contamination=0.08, random_state=0).fit_predict(z) == -1   # multivariate anomalies
            for m, fl in zip(w.index, flag):
                if fl:
                    p = z.loc[m].abs().idxmax(); zz = float(z.loc[m, p])
                    cur.execute("insert into anomalies values (%s,%s,%s,%s,%s,%s,%s)", (rid, m, p, float(w.loc[m, p]),
                        float(w.loc[m, p] - res.loc[m, p]), round(zz, 2), "High" if abs(zz) > 3 else "Moderate"))
            ins = []
            if "sst" in w:
                s = np.polyfit(np.arange(len(w)), w["sst"].values, 1)[0] * 12
                ins.append(("warn" if s > 0.1 else "info", f"Sea surface temperature is {'rising' if s > 0 else 'falling'} by about {abs(s):.2f} °C per year in this zone."))
            fc = pd.read_sql("select date_trunc('month',obs_date)::date m,count(*) n from fish_obs f join regions r on ST_Within(f.geom,r.geom) where r.id=%(r)s group by 1", c, params={"r": rid})
            if len(fc) >= 6 and "chlorophyll" in w:
                n = fc.set_index("m")["n"].reindex(w.index).fillna(0)
                if n.std() > 0:
                    r = np.corrcoef(w["chlorophyll"], n)[0, 1]
                    ins.append(("info", f"Chlorophyll and fish sightings per month have a correlation of {r:.2f} here."))
            ins.append(("warn" if (flag.sum()) else "info", f"{int(flag.sum())} anomalous month(s) detected by the Isolation Forest model."))
            for t, x in ins: cur.execute("insert into insights values (%s,%s,%s)", (rid, t, x))
    print("analysis done")

def run():
    start = os.getenv("START_DATE", "2023-01-01")
    end = (dt.date.today().replace(day=1) - dt.timedelta(days=1)).isoformat()
    ingest_ocean(start, end); ingest_fish(); analyze()

if __name__ == "__main__": run()
