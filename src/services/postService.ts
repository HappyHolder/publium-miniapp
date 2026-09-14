import type { GeneratedPost, PostStatus } from '@/types'

let posts: GeneratedPost[] = []

export const postService = {
  init(initialPosts: GeneratedPost[]) {
    posts = [...initialPosts]
  },

  remove(id: string): void { posts = posts.filter(post => post.id !== id) },

  getAll(): GeneratedPost[] {
    return posts
  },

  getByStatus(status: PostStatus): GeneratedPost[] {
    return posts.filter(p => p.status === status)
  },

  getById(id: string): GeneratedPost | undefined {
    return posts.find(p => p.id === id)
  },

  add(post: GeneratedPost): void {
    posts = [post, ...posts]
  },

  update(id: string, updates: Partial<GeneratedPost>): void {
    posts = posts.map(p => p.id === id ? { ...p, ...updates } : p)
  },

  selectVariant(postId: string, variantId: string): void {
    posts = posts.map(p => {
      if (p.id !== postId) return p
      return {
        ...p,
        selectedVariantId: variantId,
        variants: p.variants.map(v => ({ ...v, isSelected: v.id === variantId })),
      }
    })
  },

  publish(id: string): void {
    posts = posts.map(p =>
      p.id === id ? { ...p, status: 'published', publishedAt: new Date() } : p
    )
  },

  schedule(id: string, scheduledAt: Date): void {
    posts = posts.map(p =>
      p.id === id ? { ...p, status: 'scheduled', scheduledAt } : p
    )
  },

  cancelSchedule(id: string): void {
    posts = posts.map(p =>
      p.id === id ? { ...p, status: 'new', scheduledAt: undefined } : p
    )
  },

  updateVariantText(postId: string, variantId: string, text: string): void {
    posts = posts.map(p => {
      if (p.id !== postId) return p
      return {
        ...p,
        variants: p.variants.map(v => v.id === variantId ? { ...v, text } : v),
      }
    })
  },
}
