import { pgTable, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const supportConversations = pgTable("support_conversations", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("open"),
  context: jsonb("context").notNull(),
  messages: jsonb("messages").notNull().default([]),
  attempts: jsonb("attempts").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("support_owner_idx").on(t.ownerId)]);

export const supportDocuments = pgTable("support_documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  sourceUrl: text("source_url").notNull().default(""),
  namespace: text("namespace").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  status: text("status").notNull().default("pending"),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportChunks = pgTable("support_chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => supportDocuments.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sourceUrl: text("source_url").notNull().default(""),
  text: text("text").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
}, (t) => [index("support_chunk_search_idx").using("gin", sql`to_tsvector('english', ${t.text})`)]);

export const supportValidation = pgTable("support_validation", {
  id: text("id").primaryKey(),
  report: jsonb("report").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
