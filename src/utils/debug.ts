import {inspect} from 'util';

const formatDebugValue = (value: unknown) => typeof value === 'string'
  ? value
  : inspect(value, {depth: null, colors: false});

const debug = (...values: unknown[]) => {
  console.log(['[debug]', ...values.map(formatDebugValue)].join(' '));
};

export default debug;
