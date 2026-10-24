# Elpris for Homey

En privat Homey-app, der viser elprisen for hvert kvarter for et bestemt postnummer, med nettarif, afgifter og elselskabets tillæg regnet med. Alle priser kommer fra [Elpriser.dk](https://elpriser.dk/data/).

Appen er bygget til eget brug på en Homey Pro og er ikke udgivet i Homey App Store. Koden ligger her, så Elpriser.dk kan se, hvordan deres data bruges. Der er ikke givet licens til at genbruge koden.

## Hvad appen gør

**En enhed pr. sted.** Når enheden tilføjes, skriver man sit postnummer eller en netområdekode (`a791`). Appen slår stedet op og viser netselskabet som bekræftelse. Derefter vælger man sin elaftale fra listen på Elpriser.dk, eller indtaster tillægget selv.

**Værdier på enheden**, som alle kan bruges som statusindikator og i Insights:

- pris nu og næste kvarter
- gennemsnit for denne og næste time
- dagens gennemsnit, laveste og højeste pris
- forskel til dagens gennemsnit
- plads i døgnet og i det næste døgn (percentil)
- minutter til næste billige kvarter
- morgendagens gennemsnit
- billigste og dyreste time

**Flow-kort:**

- Triggere: et nyt kvarter starter, morgendagens priser er klar.
- Betingelser: prisniveauet er billig/middel/dyr, kvarteret ligger i dagens N billigste timer, pladsen i næste døgn er i et interval, prisen er under et beløb, og »forbruget skal køre nu for at være færdigt til en frist« (i ét stræk eller med pauser).

**Widget til dashboardet.** Den viser prisen nu og et søjlediagram for de næste 24 timer, farvet efter niveau, med netselskabets spidslast markeret. Et tryk folder den ud til et skema med én række pr. time. En knap åbner en stor visning i fuld skærm med i dag og i morgen.

## Brug af Elpriser.dk's data

Appen bruger to filer:

| Fil | Bruges til | Hentes |
|---|---|---|
| `timepris.json?sted=<postnummer>` | Priser pr. kvarter, niveau, percentil, rang og stedets netselskab | Højst hvert femte minut pr. sted |
| `elpriser.json` | Elaftalernes tillæg (`energyOreInclVat`) | Højst én gang i timen |

I praksis hentes der langt sjældnere end grænserne:

- `timepris.json` hentes kun, når appen ikke har en pris for det aktuelle kvarter, eller når morgendagens priser mangler efter kl. 12. Så prøver den hvert kvarter, indtil de er der. Normalt bliver det til få kald i døgnet pr. sted.
- `elpriser.json` hentes én gang i døgnet.
- Begge filer gemmes på Homey'en, så en genstart ikke giver nye kald.
- Alle enheder med samme sted deler ét opslag.
- Kaldene sendes med `User-Agent: homey-elpris-private/1.0`.

Appen bruger ikke `plan`-parametrene. Betingelsen »skal køre nu« regnes lokalt ud fra kvartererne, efter reglerne i filens `definitions`, så forskellige Flows ikke giver hver sit kald.

### Sådan regnes prisen med tillæg

- **Variabel aftale (`spotBased: true`) eller indtastet tillæg:** `oreInclVat + energyOreInclVat`. Tillægget er det samme hele døgnet, så filens `level`, `percentile` og `rank` bruges uændret.
- **Fastprisaftale (`spotBased: false`):** `oreInclVat − spotOreInclVat + energyOreInclVat`. Her ændres rækkefølgen, så niveau, percentil og rang regnes igen efter filens egne definitioner (midrank-percentil, billig ≤ 33, dyr ≥ 67).

Abonnement og Evidas/netselskabets faste betalinger er ikke med, fordi de ikke afhænger af tidspunktet.

### Tid og sommertid

Det aktuelle kvarter findes altid ud fra `start` og `end` i filen. Appen regner aldrig selv timer og minutter om. Natten med 100 kvarterer og den dobbelte kl. 02 er testet.

### Kildeangivelse

Widgeten, den udfoldede visning og den store visning viser alle »Kilde: Elpriser.dk« med link til elpriser.dk/data/#timepris, dér hvor tallene vises.

## Krav og installation

- Homey Pro med software 12.3.0 eller nyere. Widgets findes ikke på Homey Cloud.
- [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started/homey-cli).

```bash
homey app run       # kør appen fra computeren
homey app install   # installer den på Homey'en
npm test            # test af beregningerne
```

## Opbygning

```
app.js                      Planlægning hvert kvarter, deling af data, widget-opsætning
lib/PriceService.js         Hentning og cache efter Elpriser.dk's regler
lib/calc.js                 Beregninger: kvarter nu, tillæg, percentil, plan, nøgletal
lib/agreements.js           Læsning af elpriser.json
drivers/location/           Enheden: tilføjelse, indstillinger, værdier og Flow-kort
widgets/prices/             Dashboard-widget og den store visning (full.html)
locales/                    Tekster på dansk og engelsk
test/                       Test af beregningerne
```

## Status

Version 1.3.0. Appen kører på min egen Homey. Hvilken landsdel en aftale i `elpriser.json` hører til, gætter appen ud fra områdets felter. Findes aftalen ikke, bruges et tillæg, man selv har indtastet, og enheden viser en advarsel.

Appen er udviklet med hjælp fra Claude (Anthropic).
