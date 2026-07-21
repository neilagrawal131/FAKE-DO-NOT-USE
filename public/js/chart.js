// Chart controller: candlesticks + volume histogram + toggleable EMA/VWAP
// overlays, built on TradingView's Lightweight Charts (vendored locally).
import { ema, vwap } from './indicators.js';

const COLORS = {
  ema20: '#38bdf8',
  ema50: '#f59e0b',
  ema100: '#a78bfa',
  vwap: '#ec4899',
  up: '#26a69a',
  down: '#ef5350',
};

export class PriceChart {
  constructor(container) {
    this.container = container;
    const LWC = window.LightweightCharts;

    this.chart = LWC.createChart(container, {
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#9ca3af',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      },
      grid: {
        vertLines: { color: 'rgba(148,163,184,0.08)' },
        horzLines: { color: 'rgba(148,163,184,0.08)' },
      },
      rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
      timeScale: {
        borderColor: 'rgba(148,163,184,0.2)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      autoSize: true,
    });

    this.candles = this.chart.addCandlestickSeries({
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderVisible: false,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });

    this.volume = this.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    this.chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    this.lines = {};
    for (const key of ['ema20', 'ema50', 'ema100', 'vwap']) {
      this.lines[key] = this.chart.addLineSeries({
        color: COLORS[key],
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
      });
    }

    this.enabled = { ema20: true, ema50: true, ema100: true, vwap: true };
    this.bars = [];
    this.intraday = true;
  }

  setBars(bars, { intraday = true } = {}) {
    this.bars = bars;
    this.intraday = intraday;

    this.candles.setData(
      bars.map((b) => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }))
    );

    this.volume.setData(
      bars.map((b) => ({
        time: b.time,
        value: b.volume || 0,
        color: b.close >= b.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
      }))
    );

    this._recomputeOverlays();
    this.chart.timeScale().fitContent();
  }

  _recomputeOverlays() {
    const data = {
      ema20: ema(this.bars, 20),
      ema50: ema(this.bars, 50),
      ema100: ema(this.bars, 100),
      vwap: vwap(this.bars, { intraday: this.intraday }),
    };
    for (const key of Object.keys(this.lines)) {
      this.lines[key].setData(this.enabled[key] ? data[key] : []);
    }
    this._overlayData = data;
  }

  toggle(name, on) {
    if (!(name in this.enabled)) return;
    this.enabled[name] = on;
    this.lines[name].setData(on ? this._overlayData[name] : []);
  }

  // Latest indicator values for the legend readout.
  latest() {
    const out = {};
    for (const key of Object.keys(this.lines)) {
      const series = this._overlayData?.[key];
      out[key] = series && series.length ? series[series.length - 1].value : null;
    }
    return out;
  }

  destroy() {
    this.chart.remove();
  }
}

export const CHART_COLORS = COLORS;
