class Node<T> {
  data: T;
  next: Node<T> | null;
  constructor(data: T) { this.data = data; this.next = null; }
}
function reverseLinkedList(head: Node<T>): Node<T> {
  let prev: Node<T> | null = null;
  let current = head;
  while (current !== null) {
    let nextNode = current.next;
    current.next = prev;
    prev = current;
    current = nextNode;
  }
  return prev;
}
function createLinkedList(array: T[]): Node<T> {
  if (array.length === 0) { return null; }
  let head = new Node<T>(array[0]);
  let current = head;
  for (let i = 1; i < array.length; i++) { current.next = new Node<T>(array[i]); current = current.next; }
  return head;
}
