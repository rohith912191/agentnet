// Chooses the repository from configuration: PostgreSQL when database.url is set (migrations are
// applied on connect), otherwise the in-memory reference repository.

import { MemoryRepository } from './memory.js';

export async function openRepository(config, { log } = {}) {
  if (!config.database?.url) return new MemoryRepository();
  const { PostgresRepository } = await import('./postgres.js');
  return PostgresRepository.connect({ url: config.database.url, max: config.database.poolSize, log });
}
