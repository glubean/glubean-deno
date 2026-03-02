/**
 * JSONPlaceholder API Tests
 *
 * These tests demonstrate what AI can generate from an OpenAPI spec.
 * Run with: deno task test
 *
 * API Reference: @openapi.json
 */
// deno-lint-ignore no-import-prefix
import { test } from "jsr:@glubean/sdk@^0.12.0";

// ============================================================================
// Posts API Tests
// ============================================================================

export const listPosts = test(
  {
    id: "list-posts",
    name: "List All Posts",
    tags: ["posts", "smoke"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    ctx.log("Fetching all posts...");
    const start = Date.now();

    const response = await fetch(`${baseUrl}/posts`);
    const posts = await response.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/posts`,
      status: response.status,
      duration: Date.now() - start,
      responseBody: { count: posts.length, sample: posts[0] },
    });

    ctx.assert(response.status === 200, "Should return 200", {
      actual: response.status,
      expected: 200,
    });
    ctx.assert(Array.isArray(posts), "Should return array");
    ctx.assert(posts.length === 100, "Should have 100 posts", {
      actual: posts.length,
      expected: 100,
    });

    ctx.log(`Found ${posts.length} posts`);
  },
);

export const getPostById = test(
  {
    id: "get-post",
    name: "Get Post by ID",
    tags: ["posts"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const postId = 1;
    ctx.log(`Fetching post ${postId}...`);
    const start = Date.now();

    const response = await fetch(`${baseUrl}/posts/${postId}`);
    const post = await response.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/posts/${postId}`,
      status: response.status,
      duration: Date.now() - start,
      responseBody: post,
    });

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(post.id === postId, "Post ID should match", {
      actual: post.id,
      expected: postId,
    });
    ctx.assert(!!post.title, "Post should have title");
    ctx.assert(!!post.body, "Post should have body");
    ctx.assert(!!post.userId, "Post should have userId");

    ctx.log(`Post title: "${post.title.substring(0, 50)}..."`);
  },
);

export const filterPostsByUser = test(
  {
    id: "filter-posts-by-user",
    name: "Filter Posts by User ID",
    tags: ["posts"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const userId = 1;
    ctx.log(`Fetching posts for user ${userId}...`);
    const start = Date.now();

    const response = await fetch(`${baseUrl}/posts?userId=${userId}`);
    const posts = await response.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/posts?userId=${userId}`,
      status: response.status,
      duration: Date.now() - start,
      responseBody: { count: posts.length },
    });

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(posts.length > 0, "Should have posts for user");
    ctx.assert(
      posts.every((p: { userId: number }) => p.userId === userId),
      "All posts should belong to user",
      {
        actual: posts.map((p: { userId: number }) => p.userId),
        expected: `all ${userId}`,
      },
    );

    ctx.log(`User ${userId} has ${posts.length} posts`);
  },
);

export const createPost = test(
  {
    id: "create-post",
    name: "Create New Post",
    tags: ["posts", "crud"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const newPost = {
      userId: 1,
      title: "Test Post from Glubean",
      body: "This post was created by an automated test.",
    };

    ctx.log("Creating new post...", newPost);
    const start = Date.now();

    const response = await fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newPost),
    });
    const created = await response.json();

    ctx.trace({
      method: "POST",
      url: `${baseUrl}/posts`,
      status: response.status,
      duration: Date.now() - start,
      requestBody: newPost,
      responseBody: created,
    });

    ctx.assert(response.status === 201, "Should return 201 Created", {
      actual: response.status,
      expected: 201,
    });
    ctx.assert(!!created.id, "Should return post ID");
    ctx.assert(created.title === newPost.title, "Title should match");
    ctx.assert(created.body === newPost.body, "Body should match");

    ctx.log(`Created post with ID: ${created.id}`);
  },
);

export const updatePost = test(
  {
    id: "update-post",
    name: "Update Post",
    tags: ["posts", "crud"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const postId = 1;
    const updates = {
      id: postId,
      userId: 1,
      title: "Updated Title",
      body: "Updated body content",
    };

    ctx.log(`Updating post ${postId}...`);
    const start = Date.now();

    const response = await fetch(`${baseUrl}/posts/${postId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    const updated = await response.json();

    ctx.trace({
      method: "PUT",
      url: `${baseUrl}/posts/${postId}`,
      status: response.status,
      duration: Date.now() - start,
      requestBody: updates,
      responseBody: updated,
    });

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(updated.title === updates.title, "Title should be updated", {
      actual: updated.title,
      expected: updates.title,
    });

    ctx.log("Post updated successfully");
  },
);

export const deletePost = test(
  {
    id: "delete-post",
    name: "Delete Post",
    tags: ["posts", "crud"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const postId = 1;

    ctx.log(`Deleting post ${postId}...`);
    const start = Date.now();

    const response = await fetch(`${baseUrl}/posts/${postId}`, {
      method: "DELETE",
    });

    ctx.trace({
      method: "DELETE",
      url: `${baseUrl}/posts/${postId}`,
      status: response.status,
      duration: Date.now() - start,
    });

    ctx.assert(response.status === 200, "Should return 200", {
      actual: response.status,
      expected: 200,
    });

    ctx.log("Post deleted successfully");
  },
);

// ============================================================================
// Comments API Tests
// ============================================================================

export const getPostComments = test(
  {
    id: "get-post-comments",
    name: "Get Comments for Post",
    tags: ["comments"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const postId = 1;

    ctx.log(`Fetching comments for post ${postId}...`);
    const start = Date.now();

    const response = await fetch(`${baseUrl}/posts/${postId}/comments`);
    const comments = await response.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/posts/${postId}/comments`,
      status: response.status,
      duration: Date.now() - start,
      responseBody: { count: comments.length, sample: comments[0] },
    });

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(Array.isArray(comments), "Should return array");
    ctx.assert(comments.length > 0, "Post should have comments");
    ctx.assert(
      comments.every((c: { postId: number }) => c.postId === postId),
      "All comments should belong to post",
    );

    ctx.log(`Post ${postId} has ${comments.length} comments`);
  },
);

// ============================================================================
// Users API Tests
// ============================================================================

export const listUsers = test(
  {
    id: "list-users",
    name: "List All Users",
    tags: ["users", "smoke"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    ctx.log("Fetching all users...");
    const start = Date.now();

    const response = await fetch(`${baseUrl}/users`);
    const users = await response.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/users`,
      status: response.status,
      duration: Date.now() - start,
      responseBody: { count: users.length },
    });

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(Array.isArray(users), "Should return array");
    ctx.assert(users.length === 10, "Should have 10 users", {
      actual: users.length,
      expected: 10,
    });

    ctx.log(`Found ${users.length} users`);
  },
);

export const getUserById = test(
  {
    id: "get-user",
    name: "Get User by ID",
    tags: ["users"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const userId = 1;

    ctx.log(`Fetching user ${userId}...`);
    const start = Date.now();

    const response = await fetch(`${baseUrl}/users/${userId}`);
    const user = await response.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/users/${userId}`,
      status: response.status,
      duration: Date.now() - start,
      responseBody: user,
    });

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(user.id === userId, "User ID should match");
    ctx.assert(!!user.name, "User should have name");
    ctx.assert(!!user.email, "User should have email");

    ctx.log(`Found user: ${user.name} (${user.email})`);
  },
);

// ============================================================================
// Todos API Tests
// ============================================================================

export const listTodos = test(
  {
    id: "list-todos",
    name: "List All Todos",
    tags: ["todos"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    ctx.log("Fetching all todos...");
    const start = Date.now();

    const response = await fetch(`${baseUrl}/todos`);
    const todos = await response.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/todos`,
      status: response.status,
      duration: Date.now() - start,
      responseBody: { count: todos.length },
    });

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(Array.isArray(todos), "Should return array");
    ctx.assert(todos.length === 200, "Should have 200 todos", {
      actual: todos.length,
      expected: 200,
    });

    const completed = todos.filter((t: { completed: boolean }) => t.completed).length;
    ctx.log(`Found ${todos.length} todos (${completed} completed)`);
  },
);

export const filterCompletedTodos = test(
  {
    id: "filter-completed-todos",
    name: "Filter Completed Todos",
    tags: ["todos"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    ctx.log("Fetching completed todos...");
    const start = Date.now();

    const response = await fetch(`${baseUrl}/todos?completed=true`);
    const todos = await response.json();

    ctx.trace({
      method: "GET",
      url: `${baseUrl}/todos?completed=true`,
      status: response.status,
      duration: Date.now() - start,
      responseBody: { count: todos.length },
    });

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(todos.length > 0, "Should have completed todos");
    ctx.assert(
      todos.every((t: { completed: boolean }) => t.completed === true),
      "All todos should be completed",
    );

    ctx.log(`Found ${todos.length} completed todos`);
  },
);
