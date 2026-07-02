// Barrel entry for the synthesis engine. Import THIS (not synthEngine directly) so the
// engine initializes first, then every skill self-registers — avoiding the import-hoist
// temporal-dead-zone on REGISTRY. Add new primitives to the skills list below.
export * from './synthEngine'

// Side-effect imports register each verified primitive. Order doesn't matter (matcher
// scores them all); keep them after the re-export so synthEngine is fully evaluated first.
import './skills/graph'
import './skills/lruTtlStore'
import './skills/rateLimiter'
import './skills/regexEngine'
