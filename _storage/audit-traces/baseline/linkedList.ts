export class ListNode<T> {
  constructor(public data: T, public next: ListNode<T> | null = null) {}
}

/** Reverse a singly linked list in place. Returns the new head. O(n) time, O(1) space. */
export function reverseLinkedList<T>(head: ListNode<T> | null): ListNode<T> | null {
  let prev: ListNode<T> | null = null
  let current = head
  while (current !== null) {
    const next: ListNode<T> | null = current.next
    current.next = prev
    prev = current
    current = next
  }
  return prev
}

export function fromArray<T>(xs: T[]): ListNode<T> | null {
  let head: ListNode<T> | null = null
  for (let i = xs.length - 1; i >= 0; i--) head = new ListNode(xs[i], head)
  return head
}

export function toArray<T>(head: ListNode<T> | null): T[] {
  const out: T[] = []
  for (let n = head; n !== null; n = n.next) out.push(n.data)
  return out
}
