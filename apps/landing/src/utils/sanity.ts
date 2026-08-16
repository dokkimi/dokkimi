import { sanityClient } from 'sanity:client';
import { defineQuery } from 'groq';

const POSTS_QUERY = defineQuery(
  `*[_type == "post" && defined(slug.current)] | order(date desc) { _id, title, slug, description, date }`,
);

const POST_BY_SLUG_QUERY = defineQuery(
  `*[_type == "post" && slug.current == $slug][0] { _id, title, slug, description, date, body }`,
);

const TUTORIALS_QUERY = defineQuery(
  `*[_type == "tutorial" && defined(slug.current)] | order(date desc) { _id, title, slug, description, date }`,
);

const TUTORIAL_BY_SLUG_QUERY = defineQuery(
  `*[_type == "tutorial" && slug.current == $slug][0] { _id, title, slug, description, date, body }`,
);

export async function getPosts() {
  return await sanityClient.fetch(POSTS_QUERY);
}

export async function getPostBySlug(slug: string) {
  return await sanityClient.fetch(POST_BY_SLUG_QUERY, { slug });
}

export async function getTutorials() {
  return await sanityClient.fetch(TUTORIALS_QUERY);
}

export async function getTutorialBySlug(slug: string) {
  return await sanityClient.fetch(TUTORIAL_BY_SLUG_QUERY, { slug });
}
