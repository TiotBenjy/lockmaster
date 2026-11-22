import type { Generated } from 'kysely';

// Types Kysely des tables de 0001_init.sql (docs/05). `Generated` : colonne avec valeur par défaut
// (facultative à l'insertion). JSON stocké en TEXT (validé par json_valid et par zod à la lecture),
// horodatages en ms UTC, booléens en 0/1, chiffrés (*_enc) en BLOB.

type Bit = 0 | 1;
type Format = 'deb' | 'rpm' | 'apk';
export type Role = 'admin' | 'maintainer' | 'uploader' | 'auditor' | 'reader';
export type KeyState = 'active' | 'rotating_in' | 'rotating_out' | 'retired';

export interface ArtifactTable {
  sha256: string;
  sha512: string;
  sha1: string;
  md5: string;
  size: number;
  format: Format;
  created_at: number;
  derived_from: string | null;
}

export interface RepositoryTable {
  id: string;
  name: string;
  format: Format;
  distro: string;
  codename: string | null;
  components: Generated<string>;
  sign_mode: Generated<'preserve' | 'resign'>;
  signing_key_id: string | null;
  require_auth: Generated<Bit>;
  allowed_names: Generated<string>;
  origin_label: string;
  policy_id: string | null;
  created_at: number;
}

export interface RepoArchTable {
  repo_id: string;
  arch: string;
}

export interface ChannelTable {
  id: string;
  repo_id: string;
  name: string;
  promote_from: string | null;
  approval_required: Generated<Bit>;
  retain_versions: Generated<number>;
  current_generation: number | null;
}

export interface PackageVersionTable {
  id: string;
  repo_id: string;
  artifact: string;
  name: string;
  version: string;
  arch: string;
  source_name: string | null;
  source_version: string | null;
  metadata: string;
  files: string | null;
  state: 'received' | 'validating' | 'scanning' | 'pending_review' | 'approved' | 'rejected' | 'error' | 'deleted';
  origin: 'upload' | 'import' | 'mirror';
  upstream_source_id: string | null;
  uploaded_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface PackageRelationTable {
  package_id: string;
  kind: 'depends' | 'pre_depends' | 'recommends' | 'provides' | 'conflicts' | 'obsoletes' | 'replaces' | 'breaks';
  alt_group: number;
  name: string;
  op: string | null;
  version: string | null;
}

export interface ChannelEntryTable {
  channel_id: string;
  package_id: string;
  added_at: number;
  added_by: string | null;
}

export interface ScanRunTable {
  id: string;
  package_id: string;
  scanner: 'format' | 'clamav' | 'grype' | 'policy';
  scanner_version: string | null;
  db_version: string | null;
  status: 'running' | 'pass' | 'fail' | 'error' | 'timeout';
  summary: Generated<string>;
  started_at: number;
  finished_at: number | null;
}

export interface FindingTable {
  id: Generated<number>;
  scan_run_id: string;
  package_id: string;
  vuln_id: string;
  severity: 'unknown' | 'negligible' | 'low' | 'medium' | 'high' | 'critical';
  cvss: number | null;
  epss: number | null;
  epss_percentile: number | null;
  in_kev: Generated<Bit>;
  fix_state: string | null;
  fix_versions: string | null;
  first_seen: number;
}

export interface DecisionTable {
  id: string;
  package_id: string;
  verdict: 'allow' | 'warn' | 'review' | 'block';
  source: 'policy' | 'human';
  rule_id: string | null;
  actor: string | null;
  reason: string;
  created_at: number;
}

export interface WaiverTable {
  id: string;
  vuln_id: string;
  package_name: string | null;
  repo_id: string | null;
  reason: string;
  created_by: string;
  expires_at: number;
  revoked_at: number | null;
}

export interface PolicyTable {
  id: string;
  name: string;
  document: string;
  version: number;
  updated_at: number;
  updated_by: string | null;
}

export interface KevTable {
  cve_id: string;
  date_added: string | null;
  due_date: string | null;
  ransomware: number | null;
}

export interface EpssTable {
  cve_id: string;
  score: number;
  percentile: number;
}

export interface FeedStateTable {
  name: string;
  version: string | null;
  fetched_at: number | null;
  sha256: string | null;
}

export interface GenerationTable {
  channel_id: string;
  number: number;
  created_at: number;
  key_fingerprint: string;
  package_count: number;
  manifest_sha256: string;
  state: Generated<'built' | 'active' | 'retained' | 'purged'>;
}

export interface GenerationEntryTable {
  channel_id: string;
  number: number;
  path: string;
  artifact: string;
}

export interface SnapshotTable {
  id: string;
  channel_id: string;
  number: number;
  name: string;
  created_by: string;
  created_at: number;
}

export interface TargetGenerationTable {
  target: string;
  channel_id: string;
  number: number;
  state: 'pushing' | 'active' | 'superseded' | 'removed' | 'failed';
  pushed_at: number | null;
  activated_at: number | null;
  verified_at: number | null;
  error: string | null;
}

export interface TargetFileTable {
  target: string;
  path: string;
  artifact: string;
  pushed_at: number;
}

export interface SigningKeyTable {
  id: string;
  kind: 'openpgp' | 'apk-rsa';
  purpose: Generated<'repo' | 'audit'>;
  repo_id: string | null;
  fingerprint: string;
  public_key: string;
  state: KeyState;
  created_at: number;
  expires_at: number | null;
}

export interface PromotionRequestTable {
  id: string;
  package_id: string;
  from_channel: string;
  to_channel: string;
  requested_by: string;
  requested_at: number;
  state: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decided_by: string | null;
  decided_at: number | null;
  reason: string | null;
}

export interface UpstreamSourceTable {
  id: string;
  name: string;
  format: string;
  base_url: string;
  suites: string;
  archs: string;
  trusted_keys: string;
  target_repo_id: string;
  mirror_filter: string | null;
  mirror_schedule: string | null;
  index_etag: string | null;
  index_sha256: string | null;
  index_fetched_at: number | null;
  enabled: Generated<Bit>;
}

export interface UpstreamPackageTable {
  source_id: string;
  name: string;
  version: string;
  arch: string;
  location: string;
  size: number;
  sha256: string;
  relations: string;
  summary: string | null;
}

export interface AccountTable {
  id: string;
  username: string;
  display_name: Generated<string>;
  email: Generated<string>;
  password_hash: string | null;
  auth_source: 'local' | 'directory';
  directory_connector: string | null;
  directory_subject: string | null;
  totp_secret_enc: Buffer | null;
  totp_enabled: Generated<Bit>;
  totp_last_step: number | null;
  failed_logins: Generated<number>;
  locked_until: number | null;
  disabled: Generated<Bit>;
  created_at: number;
  last_login_at: number | null;
  directory_synced_at: number | null;
  elevated_at: number | null;
}

export interface RecoveryCodeTable {
  user_id: string;
  code_hash: string;
  used_at: number | null;
}

export interface LocalGroupTable {
  id: string;
  name: string;
  description: Generated<string>;
  break_glass: Generated<Bit>;
  created_at: number;
}

export interface LocalGroupMemberTable {
  group_id: string;
  account_id: string;
  added_by: string;
  added_at: number;
}

export interface DirectoryGroupTable {
  id: string;
  connector: string;
  external_id: string;
  display_name: string;
}

export interface AccountDirectoryGroupTable {
  account_id: string;
  directory_group_id: string;
  synced_at: number;
}

export interface GroupRoleTable {
  id: string;
  group_kind: 'local' | 'directory';
  local_group_id: string | null;
  directory_group_id: string | null;
  role: Role;
  repo_id: string | null;
  created_by: string;
  created_at: number;
}

export interface SessionTable {
  id_hash: string;
  user_id: string;
  csrf_token: string;
  mfa_passed: Generated<Bit>;
  mfa_method: 'totp' | 'recovery' | 'idp' | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface ApiTokenTable {
  id: string;
  token_hash: string;
  prefix: string;
  name: string;
  user_id: string;
  scopes: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface RepoCredentialTable {
  id: string;
  repo_id: string;
  username: string;
  secret_hash: string;
  label: string | null;
  purpose: Generated<'client' | 'verify'>;
  secret_enc: Buffer | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface PasswordResetTable {
  token_hash: string;
  user_id: string;
  expires_at: number;
  used_at: number | null;
}

export interface AuditEventTable {
  seq: number;
  at: number;
  actor: string;
  ip: string | null;
  action: string;
  target: string | null;
  details: string;
  prev_hash: string;
  hash: string;
}

export interface AuditCheckpointTable {
  seq: number;
  hash: string;
  signature: string;
  at: number;
}

export interface JobTable {
  id: string;
  kind: string;
  payload: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: Generated<number>;
  run_after: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  created_by: string | null;
  dedupe_key: string | null;
}

export interface JobEventTable {
  job_id: string;
  seq: number;
  at: number;
  level: string;
  message: string;
  progress: number | null;
}

export interface SettingTable {
  key: string;
  value: string;
  updated_at: number;
  updated_by: string | null;
}

export interface NotificationChannelTable {
  id: string;
  kind: 'email' | 'webhook';
  name: string;
  config_enc: Buffer;
  events: string;
  enabled: Generated<Bit>;
}

export interface DownloadStatTable {
  day: number;
  repo_id: string;
  package_name: string;
  arch: string;
  count: number;
  bytes: number;
}

export interface Database {
  artifact: ArtifactTable;
  repository: RepositoryTable;
  repo_arch: RepoArchTable;
  channel: ChannelTable;
  package_version: PackageVersionTable;
  package_relation: PackageRelationTable;
  channel_entry: ChannelEntryTable;
  scan_run: ScanRunTable;
  finding: FindingTable;
  decision: DecisionTable;
  waiver: WaiverTable;
  policy: PolicyTable;
  kev: KevTable;
  epss: EpssTable;
  feed_state: FeedStateTable;
  generation: GenerationTable;
  generation_entry: GenerationEntryTable;
  snapshot: SnapshotTable;
  target_generation: TargetGenerationTable;
  target_file: TargetFileTable;
  signing_key: SigningKeyTable;
  promotion_request: PromotionRequestTable;
  upstream_source: UpstreamSourceTable;
  upstream_package: UpstreamPackageTable;
  account: AccountTable;
  recovery_code: RecoveryCodeTable;
  local_group: LocalGroupTable;
  local_group_member: LocalGroupMemberTable;
  directory_group: DirectoryGroupTable;
  account_directory_group: AccountDirectoryGroupTable;
  group_role: GroupRoleTable;
  session: SessionTable;
  api_token: ApiTokenTable;
  repo_credential: RepoCredentialTable;
  password_reset: PasswordResetTable;
  audit_event: AuditEventTable;
  audit_checkpoint: AuditCheckpointTable;
  job: JobTable;
  job_event: JobEventTable;
  setting: SettingTable;
  notification_channel: NotificationChannelTable;
  download_stat: DownloadStatTable;
}
