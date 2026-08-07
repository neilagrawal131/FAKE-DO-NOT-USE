// Market-microstructure sandbox. Runs a synthetic limit-order-book market-making
// simulation and shows WHY market-making is a speed race: the maker earns the
// spread from uninformed flow but loses it to informed flow and to being slow.
//
//   npm run micro                 # detailed run + the adverse-selection grid
//   npm run micro -- --informed 0.4 --latency 6   # tweak one run
//
// Flags: --steps --seed --informed <0..1> --latency <steps> --half <cents>
//        --mmsize <shares> --jump <prob>
import { runSim, SIM_DEFAULTS } from '../server/microstructure/sim.js';

function flag(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
const usd = (x) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;
const pad = (s, n) => String(s).padStart(n);

const one = {
  steps: flag('steps', SIM_DEFAULTS.steps),
  seed: flag('seed', SIM_DEFAULTS.seed),
  informedFrac: flag('informed', SIM_DEFAULTS.informedFrac),
  mmLatency: flag('latency', SIM_DEFAULTS.mmLatency),
  halfSpread: flag('half', SIM_DEFAULTS.halfSpread),
  mmSize: flag('mmsize', SIM_DEFAULTS.mmSize),
  jumpProb: flag('jump', SIM_DEFAULTS.jumpProb),
};

console.log('MARKET-MAKING SIMULATION (synthetic order book)\n');
console.log(`Steps ${one.steps} · spread ±${one.halfSpread}¢ · MM size ${one.mmSize} · informed ${(one.informedFrac * 100).toFixed(0)}% · latency ${one.mmLatency} step(s)\n`);

const r = runSim(one);
console.log('Market-maker P&L (mark-to-market at true fair):');
console.log(`  TOTAL            ${usd(r.totalPnl)}`);
console.log(`    spread capture ${usd(r.spreadCapture)}   (edge earned vs fair at each fill)`);
console.log(`    inventory P&L  ${usd(r.inventoryPnl)}   (adverse selection — held inventory moving against you)`);
console.log(`  Fills ${r.totalFills}  (${r.fillsFromNoise} from noise, ${r.fillsFromInformed} from informed)`);
console.log(`  Inventory: final ${r.finalInventory}, peak |${r.maxAbsInventory}|`);
console.log(`  P&L per fill: ${usd(r.totalFills ? r.totalPnl / r.totalFills : 0)}\n`);

// The lesson, made unavoidable: sweep informed-fraction × latency and print the
// maker's TOTAL P&L. Watch it flip from green to red as either rises.
console.log('ADVERSE SELECTION & SPEED — market-maker TOTAL P&L ($)');
console.log('rows = % of flow that is informed · cols = MM latency (steps behind true fair)\n');
const informedRow = [0.05, 0.15, 0.3, 0.5];
const latencyCol = [0, 1, 3, 6, 12];
console.log('  informed\\lat  ' + latencyCol.map((l) => pad(l, 9)).join(''));
for (const inf of informedRow) {
  const cells = latencyCol.map((lat) => {
    const res = runSim({ ...one, informedFrac: inf, mmLatency: lat });
    return pad(usd(res.totalPnl), 9);
  });
  console.log('  ' + pad(`${(inf * 100).toFixed(0)}%`, 11) + '  ' + cells.join(''));
}
console.log('\nRead it: fast + mostly-uninformed (top-left) prints money; slow OR heavily-informed');
console.log('(right / bottom) bleeds it back. That green corner is where the HFT firms live —');
console.log('and it is bought with colocation and nanosecond hardware, not a laptop.');
process.exit(0);
