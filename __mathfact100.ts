// 100-prompt math/factual strict-offline bench set (decided 2026-06-30: ~100, math/factual emphasis).
// Stresses the b015-style failure mode: required-formula / precise-fact prompts where strict mode
// produces correct prose but may miss the symbolic form.
//
// promptType bands:
//   'math'    — numeric answer; keywords are glyph-ROBUST (necessary substrings, no superscript
//               glyph required) so a correct answer in any notation passes. Measures raw correctness.
//   'formula' — symbolic form REQUIRED (canonical tokens incl. superscript ²). Deliberately catches
//               the b015 prose-only gap. f101 (Pythagorean) is b015 verbatim for comparison.
//   'factual' — deterministic fact; single unambiguous answer token(s).
//
// KEYWORD CONVENTION: each entry in expectedKeywords is an OR-group — a '|'-separated list of
// acceptable surface forms; the group matches if ANY form is present. ALL groups must match
// (case-insensitive substring). This lets notation variants (x²|x^2) both pass WITHOUT weakening
// the strict all-groups requirement. The companion runner (__mathfact_bench.ts) implements this;
// the shared benchmarks.ts scorer is NOT modified. Keywords are necessary tokens a correct answer
// must contain — not cherry-picked to pass trivially (avoids the 'gameable verify' failure mode).
import type { Benchmark } from './src/CrucibleEngine/benchmarks'

const mk = (id: string, question: string, promptType: string, expectedKeywords: string[], forbiddenKeywords: string[] = []): Benchmark =>
  ({ id, question, promptType, expectedKeywords, forbiddenKeywords, addedAt: 0, source: 'seed' })

export const MATHFACT_100: Benchmark[] = [
  // ── math: arithmetic / calculus (glyph-robust numeric tokens) ──
  mk('m001', 'What is 47 × 53?', 'math', ['2491']),
  mk('m002', 'What is 144 ÷ 12?', 'math', ['12']),
  mk('m003', 'What is 15% of 200?', 'math', ['30']),
  mk('m004', 'What is 2 to the power of 10?', 'math', ['1024']),
  mk('m005', 'What is 7 factorial?', 'math', ['5040']),
  mk('m006', 'What is the greatest common divisor of 48 and 36?', 'math', ['12']),
  mk('m007', 'What is the least common multiple of 4 and 6?', 'math', ['12']),
  mk('m008', 'What is 13 squared?', 'math', ['169']),
  mk('m009', 'What is the cube root of 27?', 'math', ['3']),
  mk('m010', 'What is 256 in binary?', 'math', ['100000000']),
  mk('m011', 'What is 0xFF in decimal?', 'math', ['255']),
  mk('m012', 'What is 3/4 plus 1/8 as a fraction?', 'math', ['7/8']),
  mk('m013', 'What is the sum of the first 10 positive integers?', 'math', ['55']),
  mk('m014', 'What is 18 modulo 5?', 'math', ['3']),
  mk('m015', 'What is the square root of 169?', 'math', ['13']),
  mk('m016', 'How many seconds are in a day?', 'math', ['86400|86,400']),
  mk('m017', 'What is 5 choose 2 (binomial coefficient)?', 'math', ['10']),
  mk('m018', 'What is the average of 4, 8, and 15?', 'math', ['9']),
  mk('m019', 'What is 1000 divided by 8?', 'math', ['125']),
  mk('m020', 'What is the value of 6! / 3!?', 'math', ['120']),
  mk('m021', 'Is 97 a prime number?', 'math', ['prime'], ['not prime', 'composite', 'not a prime']),
  mk('m022', 'What is 2^16?', 'math', ['65536|65,536']),
  mk('m023', 'What is the derivative of x²?', 'math', ['2x|2·x|2*x']),
  mk('m024', 'What is the derivative of x³?', 'math', ['3x²|3x^2|3x|3·x']),
  mk('m025', 'What is the integral of 2x with respect to x?', 'math', ['x²|x^2']),
  mk('m026', 'What is the derivative of sin(x)?', 'math', ['cos']),
  mk('m027', 'What is the derivative of e^x?', 'math', ['e^x|eˣ|e^{x}']),
  mk('m028', 'What is the slope of the line y = 3x + 2?', 'math', ['3']),
  mk('m029', 'What is 25% of 80?', 'math', ['20']),
  mk('m030', 'What is the absolute value of -17?', 'math', ['17']),
  mk('m031', 'What is log base 2 of 32?', 'math', ['5']),
  mk('m032', 'What is the sum of the interior angles of a triangle in degrees?', 'math', ['180']),
  mk('m033', 'What is the area of a circle with radius 1 (in terms of π)?', 'math', ['π|pi']),
  mk('m034', 'What is 8 cubed?', 'math', ['512']),
  mk('m035', 'What is the next prime after 13?', 'math', ['17']),
  mk('m036', 'What is 0.1 + 0.2 in exact decimal arithmetic?', 'math', ['0.3']),
  mk('m037', 'How many degrees are in a full circle?', 'math', ['360']),
  mk('m038', 'What is the factorial of 0?', 'math', ['1']),
  mk('m039', 'What is the determinant of the 2x2 identity matrix?', 'math', ['1']),
  mk('m040', 'What is 99 × 99?', 'math', ['9801']),

  // ── formula: symbolic form REQUIRED (b015-style stress) ──
  mk('f101', 'What is the Pythagorean theorem?', 'formula', ['a²|a^2', 'b²|b^2', 'c²|c^2']), // b015 verbatim
  mk('f102', 'State the quadratic formula.', 'formula', ['-b', '±|+/-', '√|sqrt', '2a']),
  mk('f103', 'What is the formula for the area of a circle?', 'formula', ['πr²|πr^2|pi r^2|πr2']),
  mk('f104', 'What is the formula for the circumference of a circle?', 'formula', ['2πr|2pir|2πr']),
  mk('f105', "What is Einstein's mass-energy equivalence formula?", 'formula', ['e', 'mc²|mc^2']),
  mk('f106', 'What is the formula for the area of a triangle?', 'formula', ['½|1/2|0.5|/2', 'base', 'height']),
  mk('f107', 'State the formula for the slope between two points.', 'formula', ['y₂|y2', 'y₁|y1', 'x₂|x2', 'x₁|x1']),
  mk('f108', 'What is the binomial expansion of (a + b)²?', 'formula', ['a²|a^2', '2ab', 'b²|b^2']),
  mk('f109', 'What is the power rule for derivatives, symbolically?', 'formula', ['nx|n·x|n x', 'n-1|n − 1|n-1']),
  mk('f110', 'What is the formula for the volume of a sphere?', 'formula', ['4/3', 'πr³|πr^3|pir^3']),
  mk('f111', 'What is the distance formula between two points in 2D?', 'formula', ['√|sqrt', 'x₂|x2', 'y₂|y2']),
  mk('f112', 'What is the formula for compound interest?', 'formula', ['p', 'r', 'n', 't']),
  mk('f113', 'State the formula for the sum of the first n integers.', 'formula', ['n(n+1)/2|n(n + 1)/2']),
  mk('f114', 'What is the formula for the area of a rectangle?', 'formula', ['length', 'width']),
  mk('f115', "What is Newton's second law as a formula?", 'formula', ['f', 'ma|m·a|m a']),
  mk('f116', 'What is the formula for kinetic energy?', 'formula', ['½|1/2', 'mv²|mv^2|m*v^2|m·v²|m·v^2|mv2']), // accept explicit-multiply forms: "1/2 * m * v^2"
  mk('f117', "What is Ohm's law as a formula?", 'formula', ['v', 'ir|i·r|i r']),
  mk('f118', 'What is the sine ratio in a right triangle (SOH)?', 'formula', ['opposite', 'hypotenuse']),
  mk('f119', 'What is the formula for the perimeter of a square with side s?', 'formula', ['4s|4·s|4 × s|4 * s']),
  mk('f120', 'What is the formula for the volume of a cylinder?', 'formula', ['πr²h|πr^2h|πr²|πr^2']),

  // ── factual: deterministic single-answer facts ──
  mk('x201', 'How many bits are in a byte?', 'factual', ['8']),
  mk('x202', 'What HTTP status code means Not Found?', 'factual', ['404']),
  mk('x203', 'What is the default port for HTTPS?', 'factual', ['443']),
  mk('x204', 'What is the chemical symbol for gold?', 'factual', ['au']),
  mk('x205', 'How many planets are in the solar system?', 'factual', ['8|eight']),
  mk('x206', 'What is the speed of light in meters per second (approximately)?', 'factual', ['299', 'light']),
  mk('x207', 'What is the ASCII code for uppercase A?', 'factual', ['65']),
  mk('x208', 'What is the boiling point of water in Celsius at sea level?', 'factual', ['100']),
  mk('x209', 'What HTTP status code means Internal Server Error?', 'factual', ['500']),
  mk('x210', 'What is the default port for HTTP?', 'factual', ['80']),
  mk('x211', 'What is the freezing point of water in Fahrenheit?', 'factual', ['32']),
  mk('x212', 'How many bytes are in a kilobyte (binary)?', 'factual', ['1024']),
  mk('x213', 'What does CPU stand for?', 'factual', ['central', 'processing', 'unit']),
  mk('x214', 'What does RAM stand for?', 'factual', ['random', 'access', 'memory']),
  mk('x215', 'What is the chemical symbol for sodium?', 'factual', ['na']),
  mk('x216', 'How many continents are there on Earth?', 'factual', ['7|seven']),
  mk('x217', 'What is the largest planet in the solar system?', 'factual', ['jupiter']),
  mk('x218', 'What does HTML stand for?', 'factual', ['hypertext', 'markup', 'language']),
  mk('x219', 'What does SQL stand for?', 'factual', ['structured', 'query', 'language']),
  mk('x220', 'What is the atomic number of hydrogen?', 'factual', ['1']),
  mk('x221', 'What does DNS stand for?', 'factual', ['domain', 'name', 'system']),
  mk('x222', 'How many sides does a hexagon have?', 'factual', ['6|six']),
  mk('x223', 'What is the smallest prime number?', 'factual', ['2']),
  mk('x224', 'What HTTP status code means OK / success?', 'factual', ['200']),
  mk('x225', 'What does JSON stand for?', 'factual', ['javascript', 'object', 'notation']),
  mk('x226', 'What is the chemical formula for water?', 'factual', ['h2o|h₂o']),
  mk('x227', 'What is absolute zero in degrees Celsius (approximately)?', 'factual', ['-273|−273']),
  mk('x228', 'What does URL stand for?', 'factual', ['uniform', 'resource', 'locator']),
  mk('x229', 'What is the powerhouse of the cell?', 'factual', ['mitochondria|mitochondrion']),
  mk('x230', 'What does API stand for?', 'factual', ['application', 'programming', 'interface']),
  mk('x231', 'What is the binary representation of decimal 10?', 'factual', ['1010']),
  mk('x232', 'What does GPU stand for?', 'factual', ['graphics', 'processing', 'unit']),
  mk('x233', 'How many milliseconds are in one second?', 'factual', ['1000|1,000']),
  mk('x234', 'What is the chemical symbol for iron?', 'factual', ['fe']),
  mk('x235', 'What does TCP stand for?', 'factual', ['transmission', 'control', 'protocol']),
  mk('x236', 'How many bits are in an IPv4 address?', 'factual', ['32']),
  mk('x237', 'What is the hexadecimal for decimal 255?', 'factual', ['ff']),
  mk('x238', 'What does UTF stand for in UTF-8?', 'factual', ['unicode', 'transformation', 'format']),
  mk('x239', 'What HTTP status code means Forbidden?', 'factual', ['403']),
  mk('x240', 'What is the chemical symbol for oxygen?', 'factual', ['o']),
]
