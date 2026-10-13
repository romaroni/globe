# Every Second on Earth

A spinning globe of simulated life events (births, deaths, marriages, divorces, graduations,
new businesses, patent filings and migrations), happening in real time, in real cities.

**It is a simulation, not a live feed.** Annual national statistics are turned into
per-second random streams and placed on the map.

## Run it

```sh
npm run serve        # http://localhost:8080
```

To rebuild the data (fetches from GitHub mirrors, caches in `.cache/`):

```sh
npm install
npm run build:data
```

## How events are generated

1. **Annual counts per country.** Each type has its own source, year and coverage (table below).
   A missing country means missing data, not zero events.
2. **Real-time Poisson streams.** Each country's annual count / 31,557,600 gives events per second.
   Globally that's about 4.2 births/s, 1.9 deaths/s, 1.3 marriages/s.
3. **City by population.** Every event lands in one of the country's cities (GeoNames, 15k+ residents,
   top 250 per country), picked with odds proportional to population.
4. **Local-time rhythm.** Events are thinned by a curve over the city's local solar hour and weekday,
   normalised so annual totals are unchanged:
   - weddings peak on Saturday afternoons
   - divorces, new businesses and patents follow weekday office hours
   - births lean to the morning (scheduled deliveries), deaths to the early morning
   - graduations happen in the daytime, migration arrivals mostly in the daytime
5. **Migration arcs.** Destinations are weighted by positive net migration; origins by net emigration
   with a distance decay (most moves are regional). Net flows understate gross flows, so this is
   a lower bound.

## Sources

| Event | Source | Notes |
|---|---|---|
| Births | World Bank WDI `SP.DYN.CBRT.IN` × `SP.POP.TOTL` | via open-numbers WDI mirror |
| Deaths | World Bank WDI `SP.DYN.CDRT.IN` × `SP.POP.TOTL` | |
| Marriages | Our World in Data crude marriage rate (UN, OECD, Eurostat) | newest year since 1995; CN and IN overridden in `data/curated.csv` |
| Divorces | `data/curated.csv` | hand-compiled crude rates (Eurostat, CDC, national offices), ~55 countries |
| Graduations | Modeled | birth cohort 22 years earlier × WDI `SE.TER.ENRR` (capped at 100%) × 0.7 |
| New businesses | World Bank WDI `IC.BUS.NREG` | formal limited-liability registrations only |
| Patent filings | World Bank WDI `IP.PAT.RESD` + `IP.PAT.NRES` | |
| Migrations | World Bank WDI `SM.POP.NETM` (UN WPP) | net, not gross |
| Cities | GeoNames via `all-the-cities` | |
| Base map | `world-atlas` 110m (Natural Earth) | |

Methodology is deliberately inconsistent across countries and types. The point is texture, not accounting.

## Stack

Canvas 2D + `d3-geo` orthographic projection, `topojson-client`, and [Motion](https://motion.dev):
its spring generator shapes every event's bloom, and it animates the intro zoom, speed changes,
legend and ticker. Libraries are vendored in `vendor/`, so there's no CDN at runtime.
