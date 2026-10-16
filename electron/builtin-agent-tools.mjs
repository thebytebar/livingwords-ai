const MAX_EXPRESSION_LENGTH = 256;
const MAX_EXPRESSION_TOKENS = 100;

function validateObject(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Arguments must be an object.';
  }
  const unsupported = Object.keys(value).filter((key) => !allowedKeys.has(key));
  return unsupported.length > 0
    ? `Unsupported argument: ${unsupported[0].slice(0, 128)}.`
    : null;
}

function tokenize(expression) {
  const tokens = [];
  const matcher = /\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:([eE][+-]?\d+))?|([a-zA-Z]+)|([+\-*/%^(),]))/uy;
  let offset = 0;
  while (offset < expression.length) {
    matcher.lastIndex = offset;
    const match = matcher.exec(expression);
    if (!match) throw new Error(`Unsupported expression near "${expression.slice(offset, offset + 16)}".`);
    const [raw, number, exponent, identifier, punctuation] = match;
    if (number !== undefined) {
      tokens.push({ kind: 'number', value: Number(`${number}${exponent ?? ''}`) });
    } else if (identifier !== undefined) {
      tokens.push({ kind: 'identifier', value: identifier.toLowerCase() });
    } else {
      tokens.push({ kind: 'symbol', value: punctuation });
    }
    offset = matcher.lastIndex;
    if (tokens.length > MAX_EXPRESSION_TOKENS) throw new Error('The expression has too many parts.');
    if (!raw.length) throw new Error('The expression is invalid.');
  }
  return tokens;
}

const FUNCTIONS = Object.freeze({
  abs: { arity: 1, run: Math.abs },
  acos: { arity: 1, run: Math.acos },
  asin: { arity: 1, run: Math.asin },
  atan: { arity: 1, run: Math.atan },
  ceil: { arity: 1, run: Math.ceil },
  cos: { arity: 1, run: Math.cos },
  exp: { arity: 1, run: Math.exp },
  floor: { arity: 1, run: Math.floor },
  ln: { arity: 1, run: Math.log },
  log: { arity: 1, run: Math.log10 },
  max: { arity: null, run: Math.max },
  min: { arity: null, run: Math.min },
  round: { arity: 1, run: Math.round },
  sin: { arity: 1, run: Math.sin },
  sqrt: { arity: 1, run: Math.sqrt },
  tan: { arity: 1, run: Math.tan },
});

function calculateExpression(expression) {
  const tokens = tokenize(expression);
  let cursor = 0;
  const peek = () => tokens[cursor];
  const consume = (value) => {
    if (peek()?.value !== value) return false;
    cursor += 1;
    return true;
  };
  const expect = (value) => {
    if (!consume(value)) throw new Error(`Expected "${value}".`);
  };
  const parsePrimary = () => {
    const token = peek();
    if (!token) throw new Error('The expression ended unexpectedly.');
    if (token.kind === 'number') {
      cursor += 1;
      return token.value;
    }
    if (consume('(')) {
      const value = parseSum();
      expect(')');
      return value;
    }
    if (token.kind === 'identifier') {
      cursor += 1;
      if (consume('(')) {
        const fn = FUNCTIONS[token.value];
        if (!fn) throw new Error(`Unknown calculator function "${token.value}".`);
        const args = [];
        if (!consume(')')) {
          do {
            args.push(parseSum());
          } while (consume(','));
          expect(')');
        }
        if ((fn.arity !== null && args.length !== fn.arity)
          || (fn.arity === null && args.length < 1)) {
          throw new Error(`${token.value} received an invalid number of arguments.`);
        }
        return fn.run(...args);
      }
      if (token.value === 'pi') return Math.PI;
      if (token.value === 'e') return Math.E;
      throw new Error(`Unknown calculator value "${token.value}".`);
    }
    throw new Error(`Unexpected token "${token.value}".`);
  };
  const parsePower = () => {
    const left = parsePrimary();
    if (consume('^')) return left ** parseUnary();
    return left;
  };
  const parseUnary = () => {
    if (consume('+')) return parseUnary();
    if (consume('-')) return -parseUnary();
    return parsePower();
  };
  const parseProduct = () => {
    let value = parseUnary();
    while (true) {
      if (consume('*')) value *= parseUnary();
      else if (consume('/')) value /= parseUnary();
      else if (consume('%')) value %= parseUnary();
      else return value;
    }
  };
  const parseSum = () => {
    let value = parseProduct();
    while (true) {
      if (consume('+')) value += parseProduct();
      else if (consume('-')) value -= parseProduct();
      else return value;
    }
  };

  const result = parseSum();
  if (cursor !== tokens.length) throw new Error(`Unexpected token "${peek().value}".`);
  if (!Number.isFinite(result)) throw new Error('The expression did not produce a finite number.');
  return Object.is(result, -0) ? 0 : result;
}

export function createBuiltinAgentTools({ now = () => new Date() } = {}) {
  if (typeof now !== 'function') throw new TypeError('The date-time clock must be a function.');
  return [
    {
      name: 'calculate',
      description: 'Evaluate a bounded arithmetic expression using numbers, parentheses, +, -, *, /, %, ^, pi, e, and standard math functions (for example sqrt(2), sin(pi / 2), min(3, 5)). Angles are in radians. No code is executed.',
      permission: 'allow',
      input_schema: {
        type: 'object',
        properties: { expression: { type: 'string', minLength: 1, maxLength: MAX_EXPRESSION_LENGTH } },
        required: ['expression'],
        additionalProperties: false,
      },
      validate_input(arguments_) {
        const error = validateObject(arguments_, new Set(['expression']))
          ?? (typeof arguments_.expression !== 'string'
            || !arguments_.expression.trim()
            || arguments_.expression.length > MAX_EXPRESSION_LENGTH
            ? `Expression must contain 1–${MAX_EXPRESSION_LENGTH} characters.`
            : null);
        if (error) return error;
        try {
          calculateExpression(arguments_.expression.trim());
          return null;
        } catch (failure) {
          return failure instanceof Error ? failure.message : String(failure);
        }
      },
      async execute({ expression }) {
        return { expression, result: calculateExpression(expression.trim()) };
      },
    },
    {
      name: 'get_local_datetime',
      description: 'Get the device current date and time, including its configured local time zone. Use this instead of guessing the current local time.',
      permission: 'allow',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      validate_input(arguments_) {
        return validateObject(arguments_, new Set());
      },
      async execute() {
        const date = now();
        if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
          throw new Error('The device date and time could not be read.');
        }
        const formatter = new Intl.DateTimeFormat(undefined, {
          dateStyle: 'full',
          timeStyle: 'long',
        });
        return {
          iso: date.toISOString(),
          local: formatter.format(date),
          timeZone: formatter.resolvedOptions().timeZone,
        };
      },
    },
  ];
}
