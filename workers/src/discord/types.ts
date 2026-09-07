// Discord Interactions の最小限の型（必要なフィールドのみ）。

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: CommandOption[];
  focused?: boolean;
}

export const CommandOptionType = {
  SUB_COMMAND: 1,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  ATTACHMENT: 11,
} as const;

export interface ResolvedAttachment {
  id: string;
  filename: string;
  url: string;
  content_type?: string;
  size: number;
}

export interface Interaction {
  id: string;
  type: number;
  token: string;
  application_id: string;
  member?: {
    user: { id: string; username: string };
    roles: string[];
  };
  // DM上でのインタラクション（本人確認DMのボタン等・§5.7.3）はmemberではなくuserで送られてくる。
  user?: { id: string; username: string };
  // MESSAGE_COMPONENT interaction が紐づくメッセージ（記名許可・投票の投稿をその場で編集するために使う・§5.4）。
  message?: { id: string; channel_id: string };
  data?: {
    name?: string;
    custom_id?: string;
    options?: CommandOption[];
    resolved?: {
      users?: Record<string, { id: string; username: string }>;
      attachments?: Record<string, ResolvedAttachment>;
    };
    // MODAL_SUBMIT（type=5）のフィールド：ACTION_ROWの配列、各行にTEXT_INPUTコンポーネント。
    components?: Array<{ components: Array<{ custom_id: string; value: string }> }>;
  };
}

/** MODAL_SUBMIT interaction から custom_id 指定のテキスト入力値を取り出す。 */
export function modalFieldValue(interaction: Interaction, customId: string): string | undefined {
  for (const row of interaction.data?.components ?? []) {
    for (const c of row.components ?? []) {
      if (c.custom_id === customId) return c.value;
    }
  }
  return undefined;
}

export function findOption(options: CommandOption[] | undefined, name: string): CommandOption | undefined {
  return options?.find((o) => o.name === name);
}

export function optionValue(options: CommandOption[] | undefined, name: string): string | undefined {
  const v = findOption(options, name)?.value;
  return v === undefined ? undefined : String(v);
}

/** APPLICATION_COMMAND_AUTOCOMPLETE で「入力中」のオプションを取り出す。 */
export function focusedOption(options: CommandOption[] | undefined): CommandOption | undefined {
  return options?.find((o) => o.focused);
}

/** サブコマンド名とそのオプション配列を取り出す（/kaihatsu set 等）。 */
export function subcommand(options: CommandOption[] | undefined): { name: string; options: CommandOption[] } | null {
  const sub = options?.find((o) => o.type === CommandOptionType.SUB_COMMAND);
  if (!sub) return null;
  return { name: sub.name, options: sub.options ?? [] };
}

/** ATTACHMENT型オプションの値（添付ID）から、resolved.attachments を引いて詳細を返す。 */
export function resolvedAttachment(interaction: Interaction, optionName: string, options: CommandOption[]): ResolvedAttachment | undefined {
  const id = optionValue(options, optionName);
  if (!id) return undefined;
  return interaction.data?.resolved?.attachments?.[id];
}
