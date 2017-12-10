import * as vega from 'vega';

export function createVegaLoader(es, timefilter, dashboardContext, enableExternalUrls) {

  const SIMPLE_QUERY = '%context_query%';
  const TIMEFILTER = '%timefilter%';
  const AUTOINTERVAL = '%autointerval%';
  const MUST_CLAUSE = '%dashboard_context-must_clause%';
  const MUST_NOT_CLAUSE = '%dashboard_context-must_not_clause%';

  function queryEsData(uri) {
    uri.body = uri.body || {};
    const body = uri.body;

    if (uri[SIMPLE_QUERY]) {
      if (body.query) {
        throw new Error(`Search request contains both "${SIMPLE_QUERY}" and "body.query" values`);
      }

      const field = uri[SIMPLE_QUERY];
      if (field !== true && (typeof field !== 'string' || field.length === 0)) {
        throw new Error(`"${SIMPLE_QUERY}" can either be true (ignores timefilter), ` +
          'or it can be the name of the time field, e.g. "@timestamp"');
      }
      delete uri[SIMPLE_QUERY];

      body.query = dashboardContext();

      if (field !== true) {
        // Inject range filter based on the timefilter values
        body.query.bool.must.push({
          range: {
            [field]: createRangeFilter({ [TIMEFILTER]: true })
          }
        });
      }
    } else {
      injectQueryContextVars(body.query, true);
    }

    injectQueryContextVars(body.aggs, false);

    return es.search(uri);
  }

  /**
   * Modify ES request by processing magic keywords
   * @param {*} obj
   * @param {boolean} isQuery
   */
  function injectQueryContextVars(obj, isQuery) {
    if (obj && typeof obj === 'object') {
      if (Array.isArray(obj)) {
        // For arrays, replace MUST_CLAUSE and MUST_NOT_CLAUSE string elements
        for (let pos = 0; pos < obj.length;) {
          const item = obj[pos];
          if (isQuery && (item === MUST_CLAUSE || item === MUST_NOT_CLAUSE)) {
            const ctxTag = item === MUST_CLAUSE ? 'must' : 'must_not';
            const ctx = dashboardContext();
            if (ctx && ctx.bool && ctx.bool[ctxTag]) {
              if (Array.isArray(ctx.bool[ctxTag])) {
                // replace one value with an array of values
                obj.splice(pos, 1, ...ctx.bool[ctxTag]);
                pos += ctx.bool[ctxTag].length;
              } else {
                obj[pos++] = ctx.bool[ctxTag];
              }
            } else {
              obj.splice(pos, 1); // remove item, keep pos at the same position
            }
          } else {
            injectQueryContextVars(item, isQuery);
            pos++;
          }
        }
      } else {
        for (const prop of Object.keys(obj)) {
          const subObj = obj[prop];
          if (!subObj || typeof obj !== 'object') continue;

          // replace "interval": { "%autointerval%": true|integer } with autogenerated range based on the timepicker
          if (prop === 'interval' && subObj[AUTOINTERVAL]) {
            let size = subObj[AUTOINTERVAL];
            if (size === true) {
              size = 50; // by default, try to get ~80 values
            } else if (typeof size !== 'number') {
              throw new Error(`"${AUTOINTERVAL}" must be either true or a number`);
            }
            const bounds = getTimeRange();
            obj.interval = roundInterval((bounds.max - bounds.min) / size);
            continue;
          }

          // handle %timefilter%
          switch (subObj[TIMEFILTER]) {
            case 'min':
            case 'max':
              // Replace {"%timefilter%": "min|max", ...} object with a timestamp
              obj[prop] = getTimeBound(subObj, subObj[TIMEFILTER]);
              continue;
            case true:
              // Replace {"%timefilter%": true, ...} object with the "range" object
              createRangeFilter(subObj);
              continue;
            case undefined:
              injectQueryContextVars(subObj, isQuery);
              continue;
            default:
              throw new Error(`"${TIMEFILTER}" property must be set to true, "min", or "max"`);
          }
        }
      }
    }
  }

  /**
   * replaces given object that contains `%timefilter%` key with the timefilter bounds and optional shift & unit parameters
   * @param {object} obj
   * @return {object}
   */
  function createRangeFilter(obj) {
    obj.gte = getTimeBound(obj, 'min');
    obj.lte = getTimeBound(obj, 'max');
    obj.format = 'epoch_millis';
    delete obj[TIMEFILTER];
    delete obj.shift;
    delete obj.unit;
    return obj;
  }

  function getTimeBound(opts, type) {
    const bounds = getTimeRange();
    let result = bounds[type];

    if (opts.shift) {
      const shift = opts.shift;
      if (typeof shift !== 'number') {
        throw new Error('shift must be a numeric value');
      }
      let multiplier;
      switch (opts.unit || 'd') {
        case 'w':
        case 'week':
          multiplier = 1000 * 60 * 60 * 24 * 7;
          break;
        case 'd':
        case 'day':
          multiplier = 1000 * 60 * 60 * 24;
          break;
        case 'h':
        case 'hour':
          multiplier = 1000 * 60 * 60;
          break;
        case 'm':
        case 'minute':
          multiplier = 1000 * 60;
          break;
        case 's':
        case 'second':
          multiplier = 1000;
          break;
        default:
          throw new Error('Unknown unit value. Must be one of: [week, day, hour, minute, second]');
      }
      result += shift * multiplier;
    }

    return result;
  }
  /**
   * Adapted from src/core_plugins/timelion/common/lib/calculate_interval.js
   * @param interval (ms)
   * @returns {string}
   */
  function roundInterval(interval) {
    switch (true) {
      case (interval <= 500):         // <= 0.5s
        return '100ms';
      case (interval <= 5000):        // <= 5s
        return '1s';
      case (interval <= 7500):        // <= 7.5s
        return '5s';
      case (interval <= 15000):       // <= 15s
        return '10s';
      case (interval <= 45000):       // <= 45s
        return '30s';
      case (interval <= 180000):      // <= 3m
        return '1m';
      case (interval <= 450000):      // <= 9m
        return '5m';
      case (interval <= 1200000):     // <= 20m
        return '10m';
      case (interval <= 2700000):     // <= 45m
        return '30m';
      case (interval <= 7200000):     // <= 2h
        return '1h';
      case (interval <= 21600000):    // <= 6h
        return '3h';
      case (interval <= 86400000):    // <= 24h
        return '12h';
      case (interval <= 604800000):   // <= 1w
        return '24h';
      case (interval <= 1814400000):  // <= 3w
        return '1w';
      case (interval < 3628800000):   // <  2y
        return '30d';
      default:
        return '1y';
    }
  }

  let _timeBounds;
  function getTimeRange() {
    // Caching function
    if (_timeBounds) return _timeBounds;
    const bounds = timefilter.getBounds();
    _timeBounds = {
      min: bounds.min.valueOf(),
      max: bounds.max.valueOf()
    };
    return _timeBounds;
  }

  /**
   * ... the loader instance to use for data file loading. A
   * loader object must provide a "load" method for loading files and a
   * "sanitize" method for checking URL/filename validity. Both methods
   * should accept a URI and options hash as arguments, and return a Promise
   * that resolves to the loaded file contents (load) or a hash containing
   * sanitized URI data with the sanitized url assigned to the "href" property
   * (sanitize).
   */
  const loader = vega.loader();
  const defaultLoad = loader.load.bind(loader);
  loader.load = (uri, opts) => {
    if (typeof uri === 'object') {
      switch (opts.context) {
        case 'dataflow':
          return queryEsData(uri);
      }
      throw new Error('Unexpected url object');
    } else if (!enableExternalUrls) {
      throw new Error('External URLs have been disabled in kibana.yml');
    }
    return defaultLoad(uri, opts);
  };

  return loader;
}
