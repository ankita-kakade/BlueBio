CREATE EXTENSION IF NOT EXISTS postgis;
-- Offshore analysis zones along the Maharashtra coast (kept west of the shoreline)
CREATE TABLE regions(id text PRIMARY KEY, name text, geom geometry(Polygon,4326));
CREATE INDEX regions_gix ON regions USING gist(geom);
INSERT INTO regions VALUES
('palghar','Palghar',ST_MakeEnvelope(72.2,19.5,72.68,20.2,4326)),
('thane','Thane (Vasai-Bhayandar)',ST_MakeEnvelope(72.3,19.1,72.75,19.5,4326)),
('mumbai','Mumbai',ST_MakeEnvelope(72.3,18.8,72.76,19.1,4326)),
('raigad','Raigad (Alibag-Murud)',ST_MakeEnvelope(72.4,17.9,72.85,18.8,4326)),
('ratnagiri','Ratnagiri',ST_MakeEnvelope(72.6,16.55,73.05,17.9,4326)),
('sindhudurg','Sindhudurg (Malvan)',ST_MakeEnvelope(72.7,15.7,73.25,16.55,4326));
CREATE TABLE ocean_obs(region_id text REFERENCES regions, month date, param text, value double precision, PRIMARY KEY(region_id,month,param));
CREATE TABLE fish_obs(source text, source_id text, species text, obs_date date, geom geometry(Point,4326), PRIMARY KEY(source,source_id));
CREATE INDEX fish_gix ON fish_obs USING gist(geom);
CREATE TABLE anomalies(region_id text, month date, param text, value double precision, expected double precision, z double precision, severity text);
CREATE TABLE insights(region_id text, type text, text text);
