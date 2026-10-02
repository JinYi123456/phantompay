'use strict';

/**
 * OpenTelemetry-style distributed tracing, zero dependencies.
 *
 * Produces real W3C trace context (128-bit trace ids, 64-bit span ids),
 * parent-child span trees, span events, status and durations measured with
 * hrtime. `toOtlpJson()` emits the OTLP/JSON trace shape (resourceSpans ->
 * scopeSpans -> spans with startTimeUnixNano / endTimeUnixNano /
 * attributes), so a real collector can consume the export without
 * translation; the command center consumes the same structure for its
 * waterfall view. Spans are bounded (oldest evicted) so a long-running
 * process cannot leak memory through telemetry.
 */

const crypto = require('crypto');

const MAX_SPANS = 500;

class Tracer {
  #spans = [];
  #active = new Map(); // spanId -> span (for child attachment)
  #resource;

  constructor({ serviceName = 'phantom-pay-stage-5', resourceAttributes = {} } = {}) {
    this.#resource = {
      serviceName,
      attributes: resourceAttributes,
      startedAt: new Date().toISOString(),
    };
  }

  /** W3C traceparent-style ids: 32 hex chars trace, 16 hex chars span. */
  newTraceId() {
    return crypto.randomBytes(16).toString('hex');
  }

  newSpanId() {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Start and immediately finish a span around synchronous work. `parent`
   * is a span object (or its id); `events` are point-in-time markers.
   */
  span(name, fn, { traceId, parent, attributes = {}, events = [] } = {}) {
    const started = this.#start({ name, traceId, parent, attributes });
    try {
      const result = fn(started);
      this.#end(started, 'OK');
      return { result, span: started };
    } catch (err) {
      started.events.push({ name: 'exception', at: new Date().toISOString(), attributes: { message: err && err.message } });
      this.#end(started, 'ERROR');
      throw err;
    }
  }

  /** Manual lifecycle for async spans: start(...), work, endSpan(span). */
  #start({ name, traceId, parent, attributes, events = [] }) {
    const parentId = parent ? (typeof parent === 'string' ? parent : parent.spanId) : null;
    const resolvedTrace = traceId || (parent && typeof parent === 'object' ? parent.traceId : null) || this.newTraceId();
    const span = {
      traceId: resolvedTrace,
      spanId: this.newSpanId(),
      parentSpanId: parentId,
      name,
      attributes,
      events: events.map((e) => ({ ...e })),
      status: 'unset',
      startHr: process.hrtime.bigint(),
      startTimeUnixNano: BigInt(Date.now()) * 1000000n,
      endHr: null,
      endTimeUnixNano: null,
      durationMs: null,
    };
    this.#spans.push(span);
    this.#active.set(span.spanId, span);
    if (this.#spans.length > MAX_SPANS) {
      const evicted = this.#spans.shift();
      this.#active.delete(evicted.spanId);
    }
    return span;
  }

  endSpan(span, status = 'OK', attributes = {}) {
    if (!span || span.status !== 'unset') return span;
    span.attributes = { ...span.attributes, ...attributes };
    span.status = status;
    span.endHr = process.hrtime.bigint();
    span.endTimeUnixNano = BigInt(Date.now()) * 1000000n;
    span.durationMs = Number(span.endHr - span.startHr) / 1e6;
    return span;
  }

  #end(span, status) {
    this.endSpan(span, status);
    this.#active.delete(span.spanId);
  }

  /** Attach a point event to a live span. */
  addEvent(span, name, attributes = {}) {
    if (span) span.events.push({ name, at: new Date().toISOString(), attributes });
  }

  list({ limit = 50, traceId } = {}) {
    const source = traceId ? this.#spans.filter((s) => s.traceId === traceId) : this.#spans;
    return source.slice(-limit).map(presentSpan);
  }

  stats() {
    let errorCount = 0;
    for (const span of this.#spans) if (span.status === 'ERROR') errorCount += 1;
    return { spans: this.#spans.length, errors: errorCount, resource: this.#resource.serviceName };
  }

  /**
   * OTLP/JSON export (traces service -> resourceSpans -> scopeSpans ->
   * spans). Only finished spans are exported, matching collector semantics.
   */
  toOtlpJson() {
    const finished = this.#spans.filter((s) => s.status !== 'unset');
    return {
      resourceSpans: [
        {
          resource: {
            attributes: Object.entries(this.#resource.attributes).map(([key, value]) => ({
              key,
              value: { stringValue: String(value) },
            })),
          },
          scopeSpans: [
            {
              scope: { name: 'phantom-pay', version: '5.0.0' },
              spans: finished.map(otlpSpan),
            },
          ],
        },
      ],
    };
  }
}

function presentSpan(span) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    status: span.status,
    durationMs: span.durationMs,
    startTimeUnixNano: span.startTimeUnixNano.toString(),
    endTimeUnixNano: span.endTimeUnixNano ? span.endTimeUnixNano.toString() : null,
    attributes: span.attributes,
    events: span.events,
  };
}

function otlpSpan(span) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId || undefined,
    name: span.name,
    kind: 'SPAN_KIND_INTERNAL',
    status: span.status === 'ERROR' ? { code: 2 } : { code: 1 },
    startTimeUnixNano: span.startTimeUnixNano.toString(),
    endTimeUnixNano: span.endTimeUnixNano.toString(),
    attributes: Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value: { stringValue: typeof value === 'string' ? value : JSON.stringify(value) },
    })),
    events: span.events.map((e) => ({
      timeUnixNano: (BigInt(Date.parse(e.at)) * 1000000n).toString(),
      name: e.name,
      attributes: Object.entries(e.attributes || {}).map(([key, value]) => ({
        key,
        value: { stringValue: String(value) },
      })),
    })),
  };
}

module.exports = { Tracer, MAX_SPANS };
