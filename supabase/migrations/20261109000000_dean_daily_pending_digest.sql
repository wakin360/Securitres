CREATE TABLE public.dean_daily_digest_logs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  dean_id uuid NOT NULL,
  digest_date date NOT NULL,
  pending_count integer NOT NULL CHECK (pending_count > 0),
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  claim_token uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  last_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  sent_at timestamptz,
  error_message text CHECK (error_message IS NULL OR pg_catalog.length(error_message) <= 300),
  CONSTRAINT dean_daily_digest_logs_dean_date_key UNIQUE (dean_id, digest_date),
  CONSTRAINT dean_daily_digest_logs_state_consistency CHECK (
    (status = 'sending' AND claim_token IS NOT NULL AND sent_at IS NULL)
    OR (status = 'sent' AND claim_token IS NULL AND sent_at IS NOT NULL AND error_message IS NULL)
    OR (status = 'failed' AND claim_token IS NULL AND sent_at IS NULL)
  )
);

CREATE INDEX dean_daily_digest_logs_date_status_idx
  ON public.dean_daily_digest_logs (digest_date, status);

ALTER TABLE public.dean_daily_digest_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dean_daily_digest_logs FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_dean_daily_digests(p_digest_date date)
RETURNS TABLE (
  dean_id uuid,
  dean_email text,
  pending_count integer,
  claim_token uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  UPDATE public.dean_daily_digest_logs AS log
  SET status = 'failed',
      claim_token = NULL,
      error_message = 'Previous delivery claim expired.'
  WHERE log.digest_date = p_digest_date
    AND log.status = 'sending'
    AND log.last_attempt_at <= v_now - INTERVAL '15 minutes';

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT
      dean.id AS dean_id,
      auth_user.email::text AS dean_email,
      pg_catalog.count(DISTINCT letter.id)::integer AS pending_count
    FROM public.profiles AS dean
    JOIN auth.users AS auth_user
      ON auth_user.id = dean.id
     AND auth_user.email_confirmed_at IS NOT NULL
     AND auth_user.email IS NOT NULL
    JOIN public.dean_program_assignments AS assignment
      ON assignment.dean_id = dean.id
     AND assignment.revoked_at IS NULL
    JOIN public.academic_programs AS program
      ON program.id = assignment.program_id
     AND program.is_active IS TRUE
    JOIN public.profiles AS student
      ON student.program_id = program.id
     AND student.role = 'student'
    JOIN public.excuse_letters AS letter
      ON letter.student_id = student.id
     AND letter.status = 'pending'
    WHERE dean.role = 'dean'
    GROUP BY dean.id, auth_user.email
  ),
  claimed AS (
    INSERT INTO public.dean_daily_digest_logs AS existing (
      dean_id,
      digest_date,
      pending_count,
      status,
      attempt_count,
      claim_token,
      last_attempt_at,
      error_message,
      sent_at
    )
    SELECT
      eligible.dean_id,
      p_digest_date,
      eligible.pending_count,
      'sending',
      1,
      pg_catalog.gen_random_uuid(),
      v_now,
      NULL,
      NULL
    FROM eligible
    ON CONFLICT (dean_id, digest_date) DO UPDATE
    SET pending_count = EXCLUDED.pending_count,
        status = 'sending',
        attempt_count = existing.attempt_count + 1,
        claim_token = EXCLUDED.claim_token,
        last_attempt_at = v_now,
        error_message = NULL,
        sent_at = NULL
    WHERE (
        existing.status = 'failed'
        AND existing.last_attempt_at <= v_now - INTERVAL '5 minutes'
      )
      OR (
        existing.status = 'sending'
        AND existing.last_attempt_at <= v_now - INTERVAL '15 minutes'
      )
    RETURNING existing.dean_id, existing.pending_count, existing.claim_token
  )
  SELECT claimed.dean_id, eligible.dean_email, claimed.pending_count, claimed.claim_token
  FROM claimed
  JOIN eligible ON eligible.dean_id = claimed.dean_id;
END;
$function$;

ALTER FUNCTION public.claim_dean_daily_digests(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_dean_daily_digests(date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_dean_daily_digests(date) TO service_role;

CREATE FUNCTION public.finish_dean_daily_digest(
  p_dean_id uuid,
  p_digest_date date,
  p_claim_token uuid,
  p_status text,
  p_error_message text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'Digest status must be sent or failed.'
      USING ERRCODE = '22023';
  END IF;

  IF p_status = 'failed'
     AND (p_error_message IS NULL OR pg_catalog.length(p_error_message) > 300) THEN
    RAISE EXCEPTION 'A short failure message is required for a failed digest.'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.dean_daily_digest_logs AS log
  SET status = p_status,
      claim_token = NULL,
      sent_at = CASE
        WHEN p_status = 'sent' THEN pg_catalog.statement_timestamp()
        ELSE NULL
      END,
      error_message = CASE
        WHEN p_status = 'failed' THEN p_error_message
        ELSE NULL
      END
  WHERE log.dean_id = p_dean_id
    AND log.digest_date = p_digest_date
    AND log.status = 'sending'
    AND log.claim_token = p_claim_token;

  RETURN FOUND;
END;
$function$;

ALTER FUNCTION public.finish_dean_daily_digest(uuid, date, uuid, text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_dean_daily_digest(uuid, date, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finish_dean_daily_digest(uuid, date, uuid, text, text)
  TO service_role;
