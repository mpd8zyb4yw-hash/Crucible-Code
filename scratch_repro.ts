import { classifyFacets } from './src/CrucibleEngine/answer/answerEngine'

const q = 'implement a token bucket rate limiter class in typescript'
console.log('facets:', JSON.stringify(classifyFacets(q)))
