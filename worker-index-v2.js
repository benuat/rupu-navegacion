// worker/index.js
// Worker unificado: sirve los archivos estáticos (public/) y maneja las rutas /api/*
// Reemplaza el modelo antiguo de Pages Functions (carpeta functions/), que ya no es
// el camino recomendado por Cloudflare para proyectos nuevos.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ping" && request.method === "GET") {
      return handlePing(env);
    }

    if (url.pathname === "/api/briefing" && request.method === "POST") {
      return handleBriefing(request, env);
    }

    // Todo lo demás (index.html, etc.) lo sirve el binding de assets estáticos
    return env.ASSETS.fetch(request);
  },
};

// ---------- /api/ping ----------
async function handlePing(env) {
  const rawKey = env.TOMTOM_API_KEY || "";
  const key = rawKey.trim();
  const hasKey = !!key;
  const keyHasWhitespace = rawKey !== key;
  const keyPreview = hasKey ? key.slice(0, 4) + "..." + key.slice(-4) : null;

  let tomtomTest = null;
  if (hasKey) {
    try {
      const testUrl = `https://api.tomtom.com/search/2/geocode/Santiago.json?key=${key}&limit=1`;
      const r = await fetch(testUrl);
      const bodyText = await r.text();
      tomtomTest = { status: r.status, ok: r.ok, bodyPreview: bodyText.slice(0, 300) };
    } catch (e) {
      tomtomTest = { error: String(e) };
    }
  }

  return jsonResponse({
    workerIsAlive: true,
    hasTomtomKey: hasKey,
    keyHasWhitespace,
    keyPreview,
    tomtomTest,
  });
}

// ---------- /api/briefing ----------
async function handleBriefing(request, env) {
  const TOMTOM_KEY = (env.TOMTOM_API_KEY || "").trim();
  if (!TOMTOM_KEY) {
    return jsonResponse({ error: "Falta configurar TOMTOM_API_KEY en Cloudflare" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Body inválido, se esperaba JSON" }, 400);
  }

  const { origin, destination } = body;
  const coordsValid =
    origin &&
    destination &&
    typeof origin.lat === "number" &&
    typeof origin.lon === "number" &&
    typeof destination.lat === "number" &&
    typeof destination.lon === "number";
  if (!coordsValid) {
    return jsonResponse({ error: "Faltan coordenadas de origen o destino", detail: JSON.stringify(body) }, 400);
  }

  try {
    const routeUrl = `https://api.tomtom.com/routing/1/calculateRoute/${origin.lat},${origin.lon}:${destination.lat},${destination.lon}/json?key=${TOMTOM_KEY}&routeType=fastest&traffic=true`;

    const routeRes = await fetch(routeUrl);
    if (!routeRes.ok) {
      const errText = await routeRes.text();
      return jsonResponse({ error: "Error calculando ruta con TomTom", detail: errText }, 502);
    }
    const routeData = await routeRes.json();

    if (!routeData.routes || routeData.routes.length === 0) {
      return jsonResponse({ error: "TomTom no devolvió ninguna ruta" }, 502);
    }

    const route = routeData.routes[0];
    const summary = route.summary;
    const points = route.legs.flatMap((leg) => leg.points);

    const idxs = [0, Math.floor(points.length * 0.33), Math.floor(points.length * 0.66), points.length - 1];
    const fractions = [0, 0.33, 0.66, 1];
    const sampledPoints = [...new Set(idxs)].map((i) => points[i]).filter(Boolean);
    if (sampledPoints.length === 0) {
      return jsonResponse({ error: "La ruta calculada no tiene puntos válidos" }, 502);
    }

    const weatherPromises = sampledPoints.map((p) =>
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&hourly=precipitation_probability,precipitation,temperature_2m,windspeed_10m&forecast_days=1&timezone=auto`
      )
        .then((r) => r.json())
        .catch(() => ({ hourly: null }))
    );
    const weatherResults = await Promise.all(weatherPromises);

    const currentHour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        hour12: false,
        timeZone: "America/Santiago",
      }).format(new Date())
    );

    const distanciaKmTotal = Math.round(summary.lengthInMeters / 1000);

    let weatherAlerts = [];
    weatherResults.forEach((w, i) => {
      if (!w.hourly) return;
      const times = w.hourly.time;
      const precipProb = w.hourly.precipitation_probability;
      const wind = w.hourly.windspeed_10m;

      for (let h = currentHour; h < Math.min(currentHour + 6, times.length); h++) {
        const prob = precipProb[h] ?? 0;
        const windSpeed = wind[h] ?? 0;
        if (prob >= 50 || windSpeed >= 50) {
          weatherAlerts.push({
            puntoIndex: i,
            lat: sampledPoints[i].latitude,
            lon: sampledPoints[i].longitude,
            distanciaKm: Math.round(distanciaKmTotal * (fractions[i] ?? 0)),
            hora: times[h].split("T")[1],
            probabilidadLluvia: prob,
            vientoKmh: windSpeed,
          });
        }
      }
    });

    const trafficDelayMin = Math.round((summary.trafficDelayInSeconds || 0) / 60);
    const durationHrs = summary.travelTimeInSeconds / 3600;
    let riesgo = 10;
    riesgo += Math.min(weatherAlerts.length * 15, 45);
    riesgo += Math.min(trafficDelayMin * 1.5, 20);
    riesgo += Math.min(durationHrs * 3, 25);
    riesgo = Math.min(Math.round(riesgo), 100);

    const distanciaKm = distanciaKmTotal;
    const duracionMin = Math.round(summary.travelTimeInSeconds / 60);
    const horas = Math.floor(duracionMin / 60);
    const minutos = duracionMin % 60;

    let briefingLines = [];
    briefingLines.push(`Ruta de ${distanciaKm} km, duración estimada ${horas}h ${minutos}min.`);
    if (trafficDelayMin > 5) {
      briefingLines.push(`Hay ${trafficDelayMin} min de retraso por tráfico en la ruta.`);
    }
    if (weatherAlerts.length > 0) {
      const primera = weatherAlerts[0];
      briefingLines.push(
        `Alerta de clima: ${primera.probabilidadLluvia}% de probabilidad de lluvia cerca de las ${primera.hora} hrs${
          primera.vientoKmh >= 50 ? `, viento fuerte (${Math.round(primera.vientoKmh)} km/h)` : ""
        }.`
      );
    } else {
      briefingLines.push("Sin alertas relevantes de lluvia o viento en las próximas horas.");
    }
    briefingLines.push(
      riesgo < 30
        ? "Riesgo bajo, buenas condiciones para viajar."
        : riesgo < 60
        ? "Riesgo medio, viaja con precaución normal."
        : "Riesgo alto, considera revisar condiciones antes de salir."
    );

    return jsonResponse({
      resumen: { distanciaKm, duracionMin, trafficDelayMin, riesgo },
      ruta: { puntos: points.map((p) => [p.latitude, p.longitude]) },
      clima: {
        puntosMuestreados: sampledPoints.map((p) => ({ lat: p.latitude, lon: p.longitude })),
        alertas: weatherAlerts,
      },
      briefing: briefingLines.join(" "),
    });
  } catch (err) {
    return jsonResponse({ error: "Error interno", detail: String(err) }, 500);
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
