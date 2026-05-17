-- SEC-008: Race-Schutz fuer bootstrap-Admin-Creation.
--
-- bootstrap.ts macht SELECT COUNT + INSERT in zwei getrennten Statements
-- ohne SERIALIZABLE-Tx. Im Race-Fenster zwischen Deploy-T+0 und erstem Login
-- koennen mehrere parallele Logins beide ihren COUNT als 0 sehen und beide
-- ein INSERT mit role='admin' machen.
--
-- Partial-unique-Index schliesst das Fenster: max EIN aktiver Admin im
-- System (kann manuell via promote von member zu admin ergaenzt werden;
-- der Initial-Bootstrap ist der einzige Pfad der den Index trifft).
-- Ein zweiter paralleler INSERT wirft unique_violation (PG error code 23505)
-- — Caller mappt das auf 403 bootstrap_only.
--
-- Hinweis: die Konstante `(TRUE)` als Expression-Index erzwingt eine einzige
-- Row in der WHERE-Subset. NULL-handling ist hier irrelevant weil TRUE nie
-- NULL ist.

CREATE UNIQUE INDEX IF NOT EXISTS one_active_admin
  ON users ((TRUE))
  WHERE role = 'admin' AND status = 'active';
