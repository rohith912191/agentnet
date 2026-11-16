// Errors shared by every repository implementation, so the service layer handles a constraint
// violation the same way whether it came from PostgreSQL or the in-memory reference repository.

export class UniqueViolation extends Error {
  constructor(constraint, message) {
    super(message ?? `unique constraint violated: ${constraint}`);
    this.name = 'UniqueViolation';
    this.code = 'unique_violation';
    this.constraint = constraint;
  }
}
