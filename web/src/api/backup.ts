import client from './client';

/**
 * 定时备份 API —— 字段对齐后端 internal/api/backup.go + internal/backup/model.go。
 * 密钥/口令在读取时被脱敏：响应只含 *_set 布尔，不回显明文；更新时留空表示保持不变。
 */

export type ChannelKind = 's3' | 'webdav';

export interface S3View {
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  prefix: string;
  use_ssl: boolean;
  path_style: boolean;
  secret_access_key_set: boolean;
}

export interface WebDAVView {
  base_url: string;
  username: string;
  prefix: string;
  password_set: boolean;
}

export interface BackupChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  created_at: number;
  updated_at: number;
  s3?: S3View;
  webdav?: WebDAVView;
}

export interface BackupRun {
  id: string;
  schedule_id: string;
  channel_id: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'success' | 'failed';
  started_at: number;
  finished_at: number;
  object_path: string;
  size_bytes: number;
  error: string;
}

export interface BackupSchedule {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  channel_id: string;
  path_template: string;
  retention: number;
  created_at: number;
  updated_at: number;
  running?: boolean;
  last_run?: BackupRun;
}

// ---- request shapes (secrets included; blank = keep current on update) ----

export interface S3Input {
  endpoint: string;
  region?: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  prefix?: string;
  use_ssl: boolean;
  path_style: boolean;
}

export interface WebDAVInput {
  base_url: string;
  username: string;
  password: string;
  prefix?: string;
}

export interface ChannelInput {
  id?: string;
  name: string;
  kind: ChannelKind;
  s3?: S3Input;
  webdav?: WebDAVInput;
}

export interface ScheduleInput {
  id?: string;
  name: string;
  enabled: boolean;
  cron: string;
  channel_id: string;
  path_template?: string;
  retention: number;
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

// ---- channels ----

export async function listChannels(): Promise<BackupChannel[]> {
  const r = await client.get<{ channels: BackupChannel[] }>('/api/v1/backup/channels');
  return r.data.channels || [];
}

export async function createChannel(c: ChannelInput): Promise<BackupChannel> {
  const r = await client.post<BackupChannel>('/api/v1/backup/channels', c);
  return r.data;
}

export async function updateChannel(id: string, c: ChannelInput): Promise<BackupChannel> {
  const r = await client.put<BackupChannel>(`/api/v1/backup/channels/${id}`, c);
  return r.data;
}

export async function deleteChannel(id: string): Promise<void> {
  await client.delete(`/api/v1/backup/channels/${id}`);
}

export async function testChannel(id: string): Promise<TestResult> {
  const r = await client.post<TestResult>(`/api/v1/backup/channels/${id}/test`, {});
  return r.data;
}

export async function testChannelConfig(c: ChannelInput): Promise<TestResult> {
  const r = await client.post<TestResult>('/api/v1/backup/channels/test', c);
  return r.data;
}

// ---- schedules ----

export async function listSchedules(): Promise<BackupSchedule[]> {
  const r = await client.get<{ schedules: BackupSchedule[] }>('/api/v1/backup/schedules');
  return r.data.schedules || [];
}

export async function createSchedule(s: ScheduleInput): Promise<BackupSchedule> {
  const r = await client.post<BackupSchedule>('/api/v1/backup/schedules', s);
  return r.data;
}

export async function updateSchedule(id: string, s: ScheduleInput): Promise<BackupSchedule> {
  const r = await client.put<BackupSchedule>(`/api/v1/backup/schedules/${id}`, s);
  return r.data;
}

export async function deleteSchedule(id: string): Promise<void> {
  await client.delete(`/api/v1/backup/schedules/${id}`);
}

export async function toggleSchedule(id: string): Promise<BackupSchedule> {
  const r = await client.post<BackupSchedule>(`/api/v1/backup/schedules/${id}/toggle`, {});
  return r.data;
}

export async function runSchedule(id: string): Promise<void> {
  await client.post(`/api/v1/backup/schedules/${id}/run`, {});
}

// ---- runs ----

export async function listRuns(limit = 50): Promise<BackupRun[]> {
  const r = await client.get<{ runs: BackupRun[] }>(`/api/v1/backup/runs?limit=${limit}`);
  return r.data.runs || [];
}

// ---- restore from a channel's actual backup objects ----

/** A real backup file present on the storage channel (not the local run log). */
export interface BackupObject {
  key: string;
  size: number;
  modified: number;
}

export interface RestoreResult {
  imported: string[];
  branding_restored: boolean;
  order_restored: boolean;
  system_config_restored: boolean;
  backup_restored: boolean;
}

export async function listChannelObjects(
  id: string,
  prefix?: string
): Promise<{ objects: BackupObject[]; truncated: boolean }> {
  const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
  const r = await client.get<{ objects: BackupObject[]; truncated: boolean }>(
    `/api/v1/backup/channels/${id}/objects${q}`
  );
  return { objects: r.data.objects || [], truncated: !!r.data.truncated };
}

export async function restoreFromChannel(id: string, key: string): Promise<RestoreResult> {
  const r = await client.post<RestoreResult>(`/api/v1/backup/channels/${id}/restore`, { key });
  return r.data;
}

/** Fetch a backup object as a blob (Bearer header sent) for browser download. */
export async function downloadChannelObject(id: string, key: string): Promise<Blob> {
  const r = await client.get(`/api/v1/backup/channels/${id}/download`, {
    params: { key },
    responseType: 'blob',
  });
  return r.data as Blob;
}
