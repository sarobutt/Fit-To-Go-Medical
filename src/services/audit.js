/** Records who did what; shown to admins in the audit log. */
async function audit(db, userId, action, entity = null, entityId = null, details = null) {
  await db.query(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [userId || null, action, entity, entityId, details ? JSON.stringify(details) : null],
  );
}

module.exports = { audit };
