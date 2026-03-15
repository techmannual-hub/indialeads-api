export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: Record<string, string[]>;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

export interface JwtPayload {
  sub: string;       // user id
  tenantId: string;
  email: string;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  sub: string;       // user id
  tokenId: string;
  iat?: number;
  exp?: number;
}

// WhatsApp Cloud API types
export interface WaTextMessage {
  type: 'text';
  text: { body: string; preview_url?: boolean };
}

export interface WaTemplateMessage {
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components?: WaTemplateComponent[];
  };
}

export interface WaTemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: 'quick_reply' | 'url';
  index?: number;
  parameters: WaTemplateParameter[];
}

export interface WaTemplateParameter {
  type: 'text' | 'image' | 'video' | 'document' | 'payload';
  text?: string;
  image?: { id?: string; link?: string };
  video?: { id?: string; link?: string };
  document?: { id?: string; link?: string; filename?: string };
  payload?: string;
}

export interface WaMediaMessage {
  type: 'image' | 'video' | 'audio' | 'document';
  image?: { id?: string; link?: string; caption?: string };
  video?: { id?: string; link?: string; caption?: string };
  audio?: { id?: string; link?: string };
  document?: { id?: string; link?: string; caption?: string; filename?: string };
}

export interface WaInteractiveMessage {
  type: 'interactive';
  interactive: {
    type: 'button' | 'list' | 'product' | 'product_list';
    header?: { type: string; text?: string };
    body: { text: string };
    footer?: { text: string };
    action: Record<string, unknown>;
  };
}

export type WaMessagePayload =
  | WaTextMessage
  | WaTemplateMessage
  | WaMediaMessage
  | WaInteractiveMessage;

// BullMQ Job data types
export interface SendMessageJobData {
  tenantId: string;
  recipientId: string;      // BroadcastRecipient id
  broadcastId: string;
  leadId: string;
  phone: string;
  phoneNumberId: string;
  accessToken: string;      // decrypted at job dispatch time
  payload: WaMessagePayload;
  delayMs?: number;
}

export interface BroadcastProcessJobData {
  tenantId: string;
  broadcastId: string;
}

export interface LeadImportJobData {
  tenantId: string;
  uploadId: string;
  s3Key: string;
}

export interface AutomationJobData {
  tenantId: string;
  automationId: string;
  leadId: string;
  trigger: string;
  context: Record<string, unknown>;
}

// Automation action/condition types
export interface AutomationCondition {
  field: string;
  operator: 'eq' | 'neq' | 'contains' | 'in' | 'gt' | 'lt';
  value: string | string[] | number;
}

export interface AutomationAction {
  type: 'SEND_MESSAGE' | 'UPDATE_STATUS' | 'ADD_TAG' | 'UPDATE_STAGE' | 'WAIT';
  templateId?: string;
  status?: string;
  tagId?: string;
  stage?: string;
  delayHours?: number;
  messageText?: string;
}
