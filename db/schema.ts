import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(), userId: text("user_id").unique(), email: text("email").notNull().unique(),
  name: text("name").notNull(), role: text("role").notNull().default("member"),
  active: integer("active").notNull().default(1), budget: integer("budget").notNull().default(100),
  concurrent: integer("concurrent").notNull().default(1), created: integer("created").notNull(),
});
export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(), owner: text("owner").notNull().references(() => accounts.id),
  requestKey: text("request_key").notNull(), kind: text("kind").notNull(), title: text("title").notNull(),
  state: text("state").notNull(), cost: integer("cost").notNull(), charged: integer("charged").notNull().default(1),
  period: text("period").notNull(), remoteId: text("remote_id"), payload: text("payload").notNull(),
  result: text("result"), error: text("error"), created: integer("created").notNull(), updated: integer("updated").notNull(),
}, (t) => [uniqueIndex("jobs_owner_request").on(t.owner, t.requestKey)]);
export const media = sqliteTable("media", {
  id: text("id").primaryKey(), owner: text("owner").notNull().references(() => accounts.id),
  name: text("name").notNull(), mime: text("mime").notNull(), bytes: integer("bytes").notNull(),
  model: text("model").notNull().default("Referências"), category: text("category").notNull().default("Outras"),
  objectKey: text("object_key").notNull(), created: integer("created").notNull(),
});
export const settings = sqliteTable("settings", { key: text("key").primaryKey(), value: text("value").notNull() });
export const audit = sqliteTable("audit", { id: text("id").primaryKey(), actor: text("actor").notNull(), action: text("action").notNull(), target: text("target").notNull(), created: integer("created").notNull() });
