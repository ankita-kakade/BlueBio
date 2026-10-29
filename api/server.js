
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const db = new Pool({
  connectionString: process.env.DATABASE_URL
});

const ML = process.env.ML_URL || 'http://ml:8000';

const PARAMS = {
  sst: {
    label: 'Sea surface temperature',
    unit: '°C'
  },
  salinity: {
    label: 'Salinity',
    unit: 'PSU'
  },
  chlorophyll: {
    label: 'Chlorophyll-a',
    unit: 'mg/m³'
  },
  oxygen: {
    label: 'Dissolved oxygen',
    unit: 'mg/L'
  }
};

const app = express();
const PUB = path.join(__dirname, 'public');

const q = (sql, args) =>
  db.query(sql, args).then(result => result.rows);

const h = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(err => {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

const months = async () =>
  (
    await q(
      "SELECT DISTINCT to_char(month, 'YYYY-MM') AS m FROM ocean_obs ORDER BY 1"
    )
  ).map(row => row.m);

const R = `
  SELECT
    id,
    name,
    ST_Y(ST_Centroid(geom)) AS lat,
    ST_X(ST_Centroid(geom)) AS lon
  FROM regions
  ORDER BY lat DESC
`;

app.use(express.json());

// ---------- Authentication ----------

let SECRET;

const WEEK = 7 * 864e5;

const b64 = value =>
  Buffer.from(value).toString('base64url');

const mac = value =>
  crypto
    .createHmac('sha256', SECRET)
    .update(value)
    .digest('base64url');

const hash = (
  password,
  salt = crypto.randomBytes(16).toString('hex')
) =>
  salt + ':' +
  crypto.scryptSync(password, salt, 64).toString('hex');

const verify = (password, stored) => {
  if (!stored || typeof stored !== 'string') return false;

  const parts = stored.split(':');
  if (parts.length !== 2) return false;

  const [salt, key] = parts;
  if (!salt || !key) return false;

  const actual = Buffer.from(
    hash(password, salt).split(':')[1],
    'hex'
  );

  const expected = Buffer.from(key, 'hex');

  return (
    actual.length === expected.length &&
    actual.length > 0 &&
    crypto.timingSafeEqual(actual, expected)
  );
};

const user = req => {
  const cookie = /(?:^|;\s*)bb=([^;]+)/.exec(
    req.headers.cookie || ''
  );

  if (!cookie) return null;

  const [payload, signature] = cookie[1].split('.');

  if (!payload || !signature || !SECRET) return null;

  const expectedSignature = mac(payload);

  const supplied = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return null;
  }

  try {
    const account = JSON.parse(
      Buffer.from(payload, 'base64url').toString()
    );

    return account.exp > Date.now() ? account : null;
  } catch {
    return null;
  }
};

const login = (res, account) => {
  const payload = b64(
    JSON.stringify({
      id: account.id,
      name: account.name,
      email: account.email,
      exp: Date.now() + WEEK
    })
  );

  res.setHeader(
    'Set-Cookie',
    `bb=${payload}.${mac(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${WEEK / 1000}`
  );
};

const tries = new Map();

const limited = req => {
  const key = req.ip;

  const recent = (tries.get(key) || []).filter(
    time => Date.now() - time < 15 * 60 * 1000
  );

  recent.push(Date.now());
  tries.set(key, recent);

  return recent.length > 15;
};

// Register

app.post(
  '/api/auth/register',
  h(async (req, res) => {
    if (limited(req)) {
      return res.status(429).json({
        error: 'Too many attempts. Try again later.'
      });
    }

    const {
      name = '',
      email = '',
      password = ''
    } = req.body || {};

    const cleanName =
      typeof name === 'string' ? name.trim() : '';

    const cleanEmail =
      typeof email === 'string'
        ? email.trim().toLowerCase()
        : '';

    if (
      !cleanName ||
      !/^\S+@\S+\.\S+$/.test(cleanEmail)
    ) {
      return res.status(400).json({
        error: 'Enter your name and a valid email.'
      });
    }

    if (
      typeof password !== 'string' ||
      password.length < 8
    ) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters.'
      });
    }

    try {
      const [account] = await q(
        `INSERT INTO users (name, email, pw)
         VALUES ($1, $2, $3)
         RETURNING id, name, email`,
        [cleanName, cleanEmail, hash(password)]
      );

      login(res, account);
      return res.json({ ok: true });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'An account with this email already exists.'
        });
      }

      throw err;
    }
  })
);

// Login

app.post(
  '/api/auth/login',
  h(async (req, res) => {
    if (limited(req)) {
      return res.status(429).json({
        error: 'Too many attempts. Try again later.'
      });
    }

    const body = req.body || {};

    const email =
      typeof body.email === 'string'
        ? body.email.trim().toLowerCase()
        : '';

    const password =
      typeof body.password === 'string'
        ? body.password
        : '';

    const [account] = await q(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (!account || !verify(password, account.pw)) {
      return res.status(401).json({
        error: 'Incorrect email or password.'
      });
    }

    login(res, account);
    return res.json({ ok: true });
  })
);

// Logout

app.post('/api/auth/logout', (_, res) => {
  res.setHeader(
    'Set-Cookie',
    'bb=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
  );

  res.json({ ok: true });
});

// Current account

app.get('/api/auth/me', (req, res) => {
  const account = user(req);

  if (!account) {
    return res.status(401).json({
      error: 'Login required'
    });
  }

  res.json({
    name: account.name,
    email: account.email
  });
});

// Protect the remaining API endpoints

app.use('/api', (req, res, next) => {
  if (user(req)) return next();

  return res.status(401).json({
    error: 'Login required'
  });
});

// ---------- Pages ----------

app.get(['/', '/dashboard.html'], (req, res) => {
  if (user(req)) {
    return res.sendFile(
      path.join(PUB, 'dashboard.html')
    );
  }

  return res.redirect('/login.html');
});

app.get('/login.html', (req, res) => {
  if (user(req)) {
    return res.redirect('/');
  }

  return res.sendFile(
    path.join(PUB, 'login.html')
  );
});

app.use(express.static(PUB, { index: false }));

// ---------- Data API ----------

// Metadata

app.get(
  '/api/meta',
  h(async (_, res) => {
    res.json({
      regions: await q(R),
      months: await months(),
      params: PARAMS
    });
  })
);

// Region boundaries for the map

app.get(
  '/api/zones',
  h(async (_, res) => {
    const rows = await q(`
      SELECT
        id,
        name,
        ST_AsGeoJSON(geom)::json AS g
      FROM regions
    `);

    res.json({
      type: 'FeatureCollection',
      features: rows.map(row => ({
        type: 'Feature',
        properties: {
          id: row.id,
          name: row.name
        },
        geometry: row.g
      }))
    });
  })
);

// Map data for a selected month and parameter

app.get(
  '/api/map',
  h(async (req, res) => {
    const allMonths = await months();
    const monthIndex = Number(req.query.m);
    const month = allMonths[monthIndex];

    const param = PARAMS[req.query.param]
      ? req.query.param
      : 'sst';

    if (!month) {
      return res.status(400).json({
        error: 'Invalid month selection.'
      });
    }

    const rows = await q(
      `
      SELECT
        r.id,
        r.name,
        ST_Y(ST_Centroid(r.geom)) AS lat,
        ST_X(ST_Centroid(r.geom)) AS lon,
        o.value,
        EXISTS (
          SELECT 1
          FROM anomalies a
          WHERE a.region_id = r.id
            AND a.param = $2
            AND to_char(a.month, 'YYYY-MM') = $1
        ) AS anomaly
      FROM regions r
      JOIN ocean_obs o
        ON o.region_id = r.id
       AND to_char(o.month, 'YYYY-MM') = $1
       AND o.param = $2
      `,
      [month, param]
    );

    res.json(rows);
  })
);

// Data for one region

app.get(
  '/api/region/:id',
  h(async (req, res) => {
    const id = req.params.id;

    const allMonths = await months();
    const monthIndex = month => allMonths.indexOf(month);

    // Oceanographic data

    const env = {};

    Object.keys(PARAMS).forEach(param => {
      env[param] = allMonths.map(() => null);
    });

    const oceanRows = await q(
      `
      SELECT
        to_char(month, 'YYYY-MM') AS m,
        param,
        value
      FROM ocean_obs
      WHERE region_id = $1
      `,
      [id]
    );

    oceanRows.forEach(row => {
      const index = monthIndex(row.m);

      if (
        env[row.param] &&
        index >= 0
      ) {
        env[row.param][index] =
          Math.round(Number(row.value) * 100) / 100;
      }
    });

    // Fish observations within the selected region

    const J = `
      FROM fish_obs f
      JOIN regions r
        ON ST_Intersects(f.geom, r.geom)
      WHERE r.id = $1
    `;

    // Monthly fish record counts

    const total = allMonths.map(() => 0);

    const monthlyRows = await q(
      `
      SELECT
        to_char(f.obs_date, 'YYYY-MM') AS m,
        COUNT(*)::int AS n
      ${J}
      GROUP BY 1
      `,
      [id]
    );

    monthlyRows.forEach(row => {
      const index = monthIndex(row.m);

      if (index >= 0) {
        total[index] = row.n;
      }
    });

    // Total fish records in the region, regardless of month

    const [fishCount] = await q(
      `SELECT COUNT(*)::int AS n ${J}`,
      [id]
    );

    const fishTotal = fishCount.n;

    // Most frequently recorded species

    const species = {};

    const speciesRows = await q(
      `
      SELECT
        COALESCE(f.species, 'Unknown') AS species,
        COUNT(*)::int AS n
      ${J}
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 6
      `,
      [id]
    );

    speciesRows.forEach(row => {
      species[row.species] = row.n;
    });

    // Anomaly data

    const anomalies = (
      await q(
        `
        SELECT
          to_char(month, 'YYYY-MM') AS month_key,
          param,
          value,
          expected,
          z,
          severity
        FROM anomalies
        WHERE region_id = $1
        ORDER BY month
        `,
        [id]
      )
    ).map(row => ({
      ...row,
      month: row.month_key,
      i: monthIndex(row.month_key)
    }));

    // Additional insights

    const insights = await q(
      `
      SELECT type, text
      FROM insights
      WHERE region_id = $1
      `,
      [id]
    );

    // Return all data to the dashboard

    res.json({
      env,
      catch: {
        species,
        total,
        fishTotal
      },
      anomalies,
      insights
    });
  })
);

// ---------- ML service routes ----------

app.post(
  '/api/refresh',
  h(async (_, res) => {
    const response = await fetch(`${ML}/run`, {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(
        `ML refresh failed with status ${response.status}`
      );
    }

    res.json(await response.json());
  })
);

app.get(
  '/api/status',
  h(async (_, res) => {
    const response = await fetch(`${ML}/status`);

    if (!response.ok) {
      throw new Error(
        `ML status request failed with status ${response.status}`
      );
    }

    res.json(await response.json());
  })
);

// ---------- Database setup and server startup ----------

(async () => {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY,
      name text NOT NULL,
      email text UNIQUE NOT NULL,
      pw text NOT NULL,
      created timestamptz DEFAULT now()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS app_secret (
      k int PRIMARY KEY,
      v text
    )
  `);

  await q(
    `
    INSERT INTO app_secret (k, v)
    VALUES (1, $1)
    ON CONFLICT (k) DO NOTHING
    `,
    [crypto.randomBytes(32).toString('hex')]
  );

  const [secretRow] = await q(
    'SELECT v FROM app_secret WHERE k = 1'
  );

  if (!secretRow || !secretRow.v) {
    throw new Error('Could not load application secret.');
  }

  SECRET = secretRow.v;

  const port = Number(process.env.PORT) || 3000;

  app.listen(port, '0.0.0.0', () => {
    console.log(`BlueBio running on :${port}`);
  });
})().catch(err => {
  console.error('BlueBio startup failed:', err);
  process.exit(1);
});
