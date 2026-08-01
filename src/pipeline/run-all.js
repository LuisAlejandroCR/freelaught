import { fetchAll } from "./01-fetch.js";
import { runMatch } from "./02-match.js";
import { runForecast } from "./03-forecast.js";
import { runDerive } from "./04-derive.js";
import { backtest } from "./backtest.js";

// The one command that runs end-to-end (mandatory deliverable): fetch -> match
// -> forecast -> derive, then a free backtest against July ground truth.
async function runAll() {
  console.log("=== 1/5 Fetch ===");
  await fetchAll({ useCache: !process.argv.includes("--fresh") });

  console.log("\n=== 2/5 Match ===");
  runMatch();

  console.log("\n=== 3/5 Forecast ===");
  runForecast();

  console.log("\n=== 4/5 Derive (VIP / weekday / puntos) ===");
  runDerive();

  console.log("\n=== 5/5 Backtest (validación contra julio) ===");
  backtest();

  console.log("\nListo. matches.csv, forecast.csv y raw/derived.json generados.");
  console.log("Corre `npm run web` para ver la capa de producto en http://localhost:3000");
}

runAll();
